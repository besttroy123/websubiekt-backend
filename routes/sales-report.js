const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db'); // Import the database connection

// Variable to store the interval reference
let salesReportUpdateInterval = null;

// Function to ensure the sales_report table exists
async function ensureSalesReportTableExists() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS sales_report (
        reference TEXT,
        unit_price_tax_incl NUMERIC(12,4),
        product_quantity INTEGER,
        total_price_brutto NUMERIC(14,4),
        date_add DATE,
        product_name TEXT,
        stock_quantity INTEGER,
        rabat NUMERIC(7,4)
      )
    `);
    console.log('Sales report table check completed');
  } catch (error) {
    console.error('Error ensuring sales_report table exists:', error);
    throw error;
  }
}

// Function to ensure the raport_sprzedazy table exists
async function ensureRaportSprzedazyTableExists() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS raport_sprzedazy (
        reference TEXT,
        unit_price_tax_incl NUMERIC(12,4),
        product_quantity INTEGER,
        total_price_brutto NUMERIC(14,4),
        date_add DATE,
        product_name TEXT,
        stock_quantity INTEGER,
        rabat NUMERIC(7,4)
      )
    `);
    console.log('Raport sprzedazy table check completed');
  } catch (error) {
    console.error('Error ensuring raport_sprzedazy table exists:', error);
    throw error;
  }
}

// Function to fetch and process sales report data
async function updateSalesReport(queryParams = {}) {
  const startTime = Date.now();
  try {
    // Get environment variables
    const apiUrl = process.env.PRESTASHOP_API_URL;
    const apiToken = process.env.PRESTASHOP_API_TOKEN;

    // Get filter parameters from query params
    const { startDate, endDate, productName, reference } = queryParams;
    
    // Base params for PrestaShop API
    const params = {
      output_format: 'JSON',
      display: '[id, reference, order_rows[product_name], order_rows[product_quantity], order_rows[unit_price_tax_incl], order_rows[id], date_add, order_rows[product_attribute_id], order_rows[product_id]]',
      'filter[current_state]': '[2|3|4|5|11]'
    };
    
    // Add date filters if provided
    if (startDate && endDate) {
      params['filter[date_add]'] = `[${startDate} TO ${endDate}]`;
    }

    // Make request to PrestaShop API
    const response = await axios.get(`${apiUrl}/orders`, {
      headers: {
        'Authorization': apiToken
      },
      params: params
    });

    // Process the data to create items_orders array
    const items_orders = [];
    
    // Check if orders exist in the response
    if (response.data && response.data.orders) {
      // Iterate through each order
      response.data.orders.forEach(order => {
        // Check if order has associations and order_rows
        if (order.associations && order.associations.order_rows) {
          // Iterate through each order row
          order.associations.order_rows.forEach(row => {
            // Add each order row to items_orders with order details
            items_orders.push({
              id: row.id,  
              order_id: order.id,
              date_add: order.date_add,
              reference: order.reference,
              product_quantity: row.product_quantity,
              product_name: row.product_name,
              product_id: row.product_id,
              product_attribute_id: row.product_attribute_id,
              unit_price_tax_incl: row.unit_price_tax_incl,
              total_price_brutto: (row.unit_price_tax_incl * row.product_quantity).toFixed(2)
            });
          });
        }
      });
    }

    // Fetch stock availability data from PrestaShop API
    const stockResponse = await axios.get(`${apiUrl}/stock_availables`, {
      headers: {
        'Authorization': apiToken
      },
      params: {
        output_format: 'JSON',
        display: '[id_product, id_product_attribute, quantity]',
        language: 1
      }
    });

    // Process stock data into an array
    const stock_availables = [];
    if (stockResponse.data && stockResponse.data.stock_availables) {
      // Process stock data
      stockResponse.data.stock_availables.forEach(stock => {
        stock_availables.push({
          id_product: stock.id_product,
          id_product_attribute: stock.id_product_attribute,
          quantity: stock.quantity
        });
      });
    }
    
    console.log(`Fetched ${stock_availables.length} stock availability records`);

    // Match each item_orders with corresponding stock_availables
    items_orders.forEach(item => {
      // Find matching stock item
      const matchingStock = stock_availables.find(
        stock => stock.id_product == item.product_id && 
                 stock.id_product_attribute == item.product_attribute_id
      );
      
      // Add stock quantity to the item
      item.stock_quantity = matchingStock ? matchingStock.quantity : 0;
    });

    // Ensure the sales_report table exists
    await ensureSalesReportTableExists();
    
    // Ensure the raport_sprzedazy table exists
    await ensureRaportSprzedazyTableExists();

    // Store the data in the database
    if (items_orders.length > 0) {
      // Database operations
      const client = await db.getClient();
      try {
        await client.query('BEGIN');

        // Truncate the table to remove all previous data
        await client.query('TRUNCATE TABLE sales_report');

        // Insert each item into the database
        // Zauważ: INSERT do sales_report nie zawiera kolumny rabat,
        // więc będzie ona miała wartość domyślną (NULL)
        for (const item of items_orders) {
          await client.query(`
            INSERT INTO sales_report
            (reference, unit_price_tax_incl, product_quantity, total_price_brutto, date_add, product_name, stock_quantity)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            item.reference,
            item.unit_price_tax_incl,
            item.product_quantity,
            item.total_price_brutto,
            item.date_add,
            item.product_name,
            item.stock_quantity
          ]);
        }

        // Clear raport_sprzedazy table and populate with UNION of documents_sales and sales_report
        await client.query('TRUNCATE TABLE raport_sprzedazy');

        // Execute UNION query to merge data from both tables
        // Zmieniono CAST(NULL AS NUMERIC) na bezpośrednie odwołanie do kolumny rabat
        const unionResult = await client.query(`
          INSERT INTO raport_sprzedazy (
            reference,
            unit_price_tax_incl,
            product_quantity,
            total_price_brutto,
            date_add,
            product_name,
            stock_quantity,
            rabat
          )
          SELECT
            reference,
            unit_price_tax_incl,
            product_quantity,
            total_price_brutto,
            date_add,
            product_name,
            stock_quantity,
            rabat 
          FROM documents_sales

          UNION ALL

          SELECT
            reference,
            unit_price_tax_incl,
            product_quantity,
            total_price_brutto,
            date_add,
            product_name,
            stock_quantity,
            rabat -- Pobranie wartości rabat z sales_report (będzie NULL)
          FROM sales_report
        `);

        // Get the count of rows inserted
        const countResult = await client.query('SELECT COUNT(*) FROM raport_sprzedazy');
        const rowCount = countResult.rows[0].count;

        console.log(`Merged data inserted into raport_sprzedazy table: ${rowCount} total records`);

        await client.query('COMMIT');
        console.log(`Sales report table cleared and ${items_orders.length} new items stored in database`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error storing sales report data in database:', error);
        throw error;
      } finally {
        client.release();
      }
    }

    // Apply additional filters on the server side if needed
    let filteredItems = [...items_orders];
    
    if (productName) {
      filteredItems = filteredItems.filter(item => 
        item.product_name.toLowerCase().includes(productName.toLowerCase())
      );
    }
    
    if (reference) {
      filteredItems = filteredItems.filter(item => 
        item.reference.toLowerCase().includes(reference.toLowerCase())
      );
    }
    
    const executionTime = Date.now() - startTime;
    console.log(`Sales report update completed in: ${executionTime} ms`);
    
    return {
      items_orders: filteredItems,
      totalItems: filteredItems.length
    };
    
  } catch (error) {
    console.error('Error updating sales report data:', error);
    throw error;
  }
}

// Initialize the automatic update interval
function initializeSalesReportUpdates() {
  // Get interval from environment variable or use default (5 minutes)
  let updateInterval = process.env.API_UPDATE_INTERVAL || 300000;
  
  console.log(`Setting up automatic sales report updates every ${updateInterval} ms`);
  
  // Run an initial update
  updateSalesReport()
    .then(() => {
      console.log(`Initial sales report update completed. Next update in ${updateInterval} ms`);
    })
    .catch(err => {
      console.error('Error during initial sales report update:', err);
    });
  
  // Set up the interval for future updates
  salesReportUpdateInterval = setInterval(async () => {
    try {
      console.log('Starting scheduled sales report update...');
      await updateSalesReport();
      
      // Check if the interval has changed
      const newInterval = process.env.API_UPDATE_INTERVAL || 300000;
      if (newInterval !== updateInterval) {
        console.log(`Interval time changed from ${updateInterval} ms to ${newInterval} ms`);
        clearInterval(salesReportUpdateInterval);
        updateInterval = newInterval;
        
        salesReportUpdateInterval = setInterval(async () => {
          try {
            console.log('Starting scheduled sales report update...');
            await updateSalesReport();
            console.log(`Sales report update completed. Next update in ${updateInterval} ms`);
          } catch (error) {
            console.error('Error during scheduled sales report update:', error);
          }
        }, parseInt(updateInterval));
      } else {
        console.log(`Sales report update completed. Next update in ${updateInterval} ms`);
      }
    } catch (error) {
      console.error('Error during scheduled sales report update:', error);
    }
  }, updateInterval);
  
  return salesReportUpdateInterval;
}

// Start the automatic updates when the module is loaded
initializeSalesReportUpdates();

// Add a route to change the update interval dynamically
router.get('/set-interval', (req, res) => {
  try {
    const newInterval = req.query.interval;
    
    if (!newInterval || isNaN(parseInt(newInterval))) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid interval value. Please provide a valid number in milliseconds.' 
      });
    }
    
    // Update the environment variable
    process.env.API_UPDATE_INTERVAL = newInterval;
    
    // Clear the existing interval and restart with new time
    if (salesReportUpdateInterval) {
      clearInterval(salesReportUpdateInterval);
      console.log(`Sales report interval cleared. Setting up new interval of ${newInterval} ms`);
      
      // Set up new interval with the updated time
      salesReportUpdateInterval = setInterval(async () => {
        try {
          console.log('Starting scheduled sales report update...');
          await updateSalesReport();
          console.log(`Sales report update completed. Next update in ${newInterval} ms`);
        } catch (error) {
          console.error('Error during scheduled sales report update:', error);
        }
      }, parseInt(newInterval));
    }
    
    res.json({ 
      success: true, 
      message: `Sales report update interval changed to ${newInterval} ms and applied immediately.` 
    });
  } catch (error) {
    console.error('Error changing sales report update interval:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to change sales report update interval',
      error: error.message
    });
  }
});

// Get sales report data
router.get('/', async (req, res) => {
  try {
    // Return the current data from the database
    const result = await db.query('SELECT * FROM sales_report');
    
    // Apply filters if provided
    let filteredData = result.rows;
    const { productName, reference } = req.query;
    
    if (productName) {
      filteredData = filteredData.filter(item => 
        item.product_name.toLowerCase().includes(productName.toLowerCase())
      );
    }
    
    if (reference) {
      filteredData = filteredData.filter(item => 
        item.reference.toLowerCase().includes(reference.toLowerCase())
      );
    }
    
    res.json({ 
      items_orders: filteredData,
      totalItems: filteredData.length
    });
  } catch (error) {
    console.error('Error fetching sales report data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch sales report data',
      details: error.message
    });
  }
});

// Force refresh of sales report data
router.get('/refresh', async (req, res) => {
  try {
    const result = await updateSalesReport(req.query);
    res.json(result);
  } catch (error) {
    console.error('Error refreshing sales report data:', error);
    res.status(500).json({ 
      error: 'Failed to refresh sales report data',
      details: error.message
    });
  }
});

module.exports = router;