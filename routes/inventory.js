const express = require('express');
const axios = require('axios');
const router = express.Router();
const xml2js = require('xml2js');
const { pool } = require('../db'); // Importowanie puli połączeń do bazy danych PostgreSQL

// Tablice do przechowywania przetworzonych danych
let combinations = [];
let products = [];
let product_option_values = [];
let stock_availables = [];
let stan_magazynowy = [];

// Variable to store the interval reference
let inventoryUpdateInterval = null;

// Function to handle the inventory update process
async function updateInventory() {
  const startTime = Date.now(); // Początek pomiaru czasu
  const PRESTASHOP_API_URL = process.env.PRESTASHOP_API_URL;
  const PRESTASHOP_API_TOKEN = process.env.PRESTASHOP_API_TOKEN;

  try {
    // Krok 1: Pobieranie danych combinations
    await fetchCombinations(PRESTASHOP_API_URL, PRESTASHOP_API_TOKEN);  
    
    // Krok 2: Pobieranie danych products
    await fetchProducts(PRESTASHOP_API_URL, PRESTASHOP_API_TOKEN);
    
    // Krok 3: Pobieranie danych product_option_values
    await fetchProductOptionValues(PRESTASHOP_API_URL, PRESTASHOP_API_TOKEN);
    
    // Krok 4: Pobieranie danych stock_availables
    await fetchStockAvailables(PRESTASHOP_API_URL, PRESTASHOP_API_TOKEN);
    
    // Krok 5: Łączenie danych
    mergeData();
    
    // Krok 6: Zapis do bazy danych PostgreSQL
    await updateDatabase(stan_magazynowy);
    
    // Obliczenie czasu wykonania
    const executionTime = Date.now() - startTime;
    console.log(`Czas wykonania aktualizacji magazynu: ${executionTime} ms`);
    
    return stan_magazynowy;
  } catch (error) {
    console.error('Error updating inventory data:', error);
    throw error;
  }
}

// Initialize the automatic update interval (runs every 5 minutes by default)
function initializeAutomaticUpdates() {
  // Default interval is 5 minutes (300000 ms)
  let updateInterval = process.env.API_UPDATE_INTERVAL || 300000;
  
  console.log(`Setting up automatic inventory updates every ${updateInterval} ms`);
  
  // Run an initial update
  updateInventory()
    .then(() => {
      console.log(`Initial inventory update completed. Next update in ${updateInterval} ms`);
    })
    .catch(err => {
      console.error('Error during initial inventory update:', err);
    });
  
  // Set up the interval for future updates
  inventoryUpdateInterval = setInterval(async () => {
    try {
      // Check if the interval has changed
      const newInterval = process.env.API_UPDATE_INTERVAL || 300000;
      
      // If interval has changed, clear current interval and set up a new one
      if (newInterval !== updateInterval) {
        console.log(`Interval time changed from ${updateInterval} ms to ${newInterval} ms`);
        clearInterval(inventoryUpdateInterval);
        updateInterval = newInterval;
        
        inventoryUpdateInterval = setInterval(async () => {
          try {
            console.log('Starting scheduled inventory update...');
            await updateInventory();
            
            // Check for interval changes on each execution
            const currentInterval = process.env.INVENTORY_UPDATE_INTERVAL || 300000;
            if (currentInterval !== updateInterval) {
              console.log(`Interval time changed from ${updateInterval} ms to ${currentInterval} ms`);
              clearInterval(inventoryUpdateInterval);
              initializeAutomaticUpdates(); // Restart with new interval
              return;
            }
            
            console.log(`Inventory update completed. Next update in ${updateInterval} ms`);
          } catch (error) {
            console.error('Error during scheduled inventory update:', error);
          }
        }, updateInterval);
        
        return;
      }
      
      console.log('Starting scheduled inventory update...');
      await updateInventory();
      console.log(`Inventory update completed. Next update in ${updateInterval} ms`);
    } catch (error) {
      console.error('Error during scheduled inventory update:', error);
    }
  }, updateInterval);
  
  return inventoryUpdateInterval;
}

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
    
    res.json({ 
      success: true, 
      message: `Inventory update interval changed to ${newInterval} ms. Will take effect on next execution.` 
    });
  } catch (error) {
    console.error('Error changing inventory update interval:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to change inventory update interval',
      error: error.message
    });
  }
});

// Start the automatic updates when the module is loaded
initializeAutomaticUpdates();

// Get combinations and products from Prestashop API
router.get('/', async (req, res) => {
  try {
    // For the API endpoint, we'll return the current data without triggering a new update
    res.json(stan_magazynowy);
  } catch (error) {
    console.error('Error fetching data from Prestashop:', error);
    res.status(500).json({ message: 'Error fetching data from Prestashop' });
  }
});

// Funkcja do pobierania danych combinations
async function fetchCombinations(apiUrl, apiToken) {
  // Parametry zapytania dla combinations
  const queryParams = {
    display: '[id, id_product, price, reference, ean13, product_option_values[id]]',
    output_format: 'XML'
  };

  try {
    // Wysyłanie żądania do Prestashop API
    const response = await axios.get(`${apiUrl}/combinations`, {
      headers: {
        'Authorization': `${apiToken}`
      },
      params: queryParams,
      responseType: 'text'
    });

    // Konwersja XML na JSON
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    return new Promise((resolve, reject) => {
      parser.parseString(response.data, (err, result) => {
        if (err) {
          console.error('Error parsing XML:', err);
          reject(err);
          return;
        }
        
        // Przetwarzanie danych JSON
        const combinationsData = result.prestashop.combinations.combination;
        combinations = Array.isArray(combinationsData) 
          ? combinationsData.map(processCombination) 
          : [processCombination(combinationsData)];
        
        resolve();
      });
    });
  } catch (error) {
    console.error('Error fetching combinations:', error);
    throw error;
  }
}

// Funkcja do pobierania danych products
async function fetchProducts(apiUrl, apiToken) {
  // Parametry zapytania dla products
  const queryParams = {
    output_format: 'JSON',
    display: '[id,name,price, id_tax_rules_group]',
    language: 1,
    'filter[active]': '[1]'
  };

  try {
    // Wysyłanie żądania do Prestashop API
    const response = await axios.get(`${apiUrl}/products`, {
      headers: {
        'Authorization': `${apiToken}`
      },
      params: queryParams
    });

    // Dane są już w formacie JSON, więc możemy je bezpośrednio przypisać
    products = response.data.products || [];
    
    return products;
  } catch (error) {
    console.error('Error fetching products:', error);
    throw error;
  }
}

// Funkcja do pobierania danych product_option_values
async function fetchProductOptionValues(apiUrl, apiToken) {
  // Parametry zapytania dla product_option_values
  const queryParams = {
    output_format: 'JSON',
    display: '[id,name]',
    language: 1
  };

  try {
    // Wysyłanie żądania do Prestashop API
    const response = await axios.get(`${apiUrl}/product_option_values`, {
      headers: {
        'Authorization': `${apiToken}`
      },
      params: queryParams
    });

    // Dane są już w formacie JSON, więc możemy je bezpośrednio przypisać
    product_option_values = response.data.product_option_values || [];
    
    return product_option_values;
  } catch (error) {
    console.error('Error fetching product option values:', error);
    throw error;
  }
}

// Funkcja do przetwarzania pojedynczego obiektu combination
function processCombination(combination) {
  // Ekstrakcja ID z product_option_values
  let associations = [];
  if (combination.associations && combination.associations.product_option_values) {
    const povs = combination.associations.product_option_values.product_option_value;
    // Obsługa zarówno pojedynczego elementu jak i tablicy
    if (Array.isArray(povs)) {
      associations = povs.map(item => {
        const match = item['xlink:href'] ? item['xlink:href'].match(/(\d+)$/) : null;
        return match ? match[1] : null;
      }).filter(id => id !== null);
    } else if (povs && povs['xlink:href']) {
      const match = povs['xlink:href'].match(/(\d+)$/);
      if (match) {
        associations = [match[1]];
      }
    }
  }

  // Tworzenie nowego obiektu z wybranymi polami i zmienionymi nazwami
  return {
    id_combination: combination.id,
    id_product: combination.id_product ? combination.id_product._ : null,
    reference: combination.reference,
    price_new: combination.price,
    associations: associations,
    ean13: combination.ean13
  };
}

// Funkcja do pobierania danych stock_availables
async function fetchStockAvailables(apiUrl, apiToken) {
  // Parametry zapytania dla stock_availables
  const queryParams = {
    output_format: 'JSON',
    display: '[id,id_product,id_product_attribute,quantity]',
    language: 1
  };

  try {
    // Wysyłanie żądania do Prestashop API
    const response = await axios.get(`${apiUrl}/stock_availables`, {
      headers: {
        'Authorization': `${apiToken}`
      },
      params: queryParams
    });

    // Dane są już w formacie JSON, więc możemy je bezpośrednio przypisać
    stock_availables = response.data.stock_availables || [];
    
    return stock_availables;
  } catch (error) {
    console.error('Error fetching stock availables:', error);
    throw error;
  }
}

// Funkcja łącząca dane z wszystkich tabel
function mergeData() {
  // First, identify products that have variants
  const productsWithVariants = new Set();
  combinations.forEach(variant => {
    if (variant.id_product) {
      productsWithVariants.add(String(variant.id_product));
    }
  });

  stan_magazynowy = stock_availables.map(stock => {
    const productId = stock.id_product;
    const variantId = stock.id_product_attribute;

    const product = products.find(p => String(p.id) === String(productId));
    if (!product) return null;

    const quantity = parseInt(stock.quantity) || 0;
    const productPrice = parseFloat(product.price) || 0;
    const taxRulesGroup = parseInt(product.id_tax_rules_group) || 0;

    // Jeśli variantId > 0 to jest to wariant
    if (parseInt(variantId) > 0) {
      const variant = combinations.find(v => String(v.id_combination) === String(variantId));
      if (!variant) return null;

      const variantPrice = parseFloat(variant.price_new) || 0;
      let cenaSprzedazyBrutto = parseFloat((productPrice + variantPrice).toFixed(2));
      
      // Dodanie podatku 23% dla produktów z id_tax_rules_group = 1
      if (taxRulesGroup === 1) {
        cenaSprzedazyBrutto = parseFloat((cenaSprzedazyBrutto * 1.23).toFixed(2));
      }

      // Pobieranie nazw opcji wariantu
      const opcje = Array.isArray(variant.associations)
        ? variant.associations
            .map(id => {
              const match = product_option_values.find(opt => String(opt.id) === String(id));
              return match ? match.name : null;
            })
            .filter(Boolean)
        : [];

      return {
        id_stock: stock.id,
        id_wariantu: variantId,
        id_produktu: productId,
        reference: variant.reference,
        ean13: variant.ean13,
        cena_wariant: variantPrice,
        opcje: opcje.join(', '),
        stan_magazynowy: quantity,
        cena_produktu: productPrice,
        nazwa_produktu: product.name,
        cena_sprzedazy_brutto: cenaSprzedazyBrutto
      };
    }

    // Skip products that have variants
    if (productsWithVariants.has(String(productId))) {
      return null;
    }

    let finalPrice = Number(productPrice); // Upewniamy się, że to liczba

    if (taxRulesGroup === 1) {
    finalPrice = (finalPrice * 1.23).toFixed(2);
    }

    return {
      id_stock: stock.id,
      id_produktu: productId,
      reference: product.reference,
      ean13: product.ean13,
      cena_produktu: productPrice,
      opcje: '',
      stan_magazynowy: quantity,
      nazwa_produktu: product.name,
      cena_sprzedazy_brutto: finalPrice
    };
  }).filter(item => item !== null);
}

// Funkcja do zaktualizowania lub dodania danych w bazie PostgreSQL
async function updateDatabase(stan_magazynowy) {
  const client = await pool.connect();

  try {
    // Tworzenie tabeli, jeśli nie istnieje
    await client.query(`
      CREATE TABLE IF NOT EXISTS stan_magazynowy (
        id SERIAL PRIMARY KEY,
        id_stock INT UNIQUE,
        id_wariantu INT,
        id_produktu INT,
        reference VARCHAR,
        ean13 VARCHAR,
        cena_wariant DECIMAL,
        opcje TEXT,
        stan_magazynowy INT,
        cena_produktu DECIMAL,
        nazwa_produktu TEXT,
        cena_sprzedazy_brutto DECIMAL,
        cena_zakupu_netto DECIMAL,
        cena_zakupu_brutto DECIMAL,
        data_ostatniej_faktury_zakupu DATE,
        grupa_towarowa TEXT -- Dodano pole grupa_towarowa
      );
    `);

    // Pobieranie danych o cenach zakupu z tabeli product_prices
    const productPricesResult = await client.query(`
      SELECT tw_symbol as ean13, ob_cenanetto as cena_zakupu_netto, ob_cenabrutto as cena_zakupu_brutto, grt_nazwa as grupa_towarowa
      FROM product_prices
    `);
    
    const productPrices = productPricesResult.rows;
    
    // Mapowanie danych o cenach zakupu do stanu magazynowego
    const updatedStanMagazynowy = stan_magazynowy.map(item => {
      // Szukamy odpowiadającego produktu po ean13
      const matchingPrice = productPrices.find(price => price.ean13 === item.ean13);
      
      // Jeśli znaleziono, dodajemy ceny zakupu i grupę towarową
      if (matchingPrice) {
        return {
          ...item,
          cena_zakupu_netto: matchingPrice.cena_zakupu_netto,
          cena_zakupu_brutto: matchingPrice.cena_zakupu_brutto,
          grupa_towarowa: matchingPrice.grupa_towarowa // Dodano mapowanie grupy towarowej
        };
      }
      
      // Jeśli nie znaleziono, zostawiamy null dla cen zakupu i grupy towarowej
      return {
        ...item,
        cena_zakupu_netto: null,
        cena_zakupu_brutto: null,
        grupa_towarowa: null // Domyślna wartość null dla grupy towarowej
      };
    });

    // Najpierw usuwamy wszystkie istniejące dane
    await client.query('TRUNCATE TABLE stan_magazynowy');

    // Przygotowanie danych do masowego wstawienia
    if (updatedStanMagazynowy.length > 0) {
      // Tworzymy zapytanie z wieloma wartościami
      const values = [];
      const valueStrings = [];
      let valueCounter = 1;

      for (let i = 0; i < updatedStanMagazynowy.length; i++) {
        const item = updatedStanMagazynowy[i];
        values.push(
          item.id_stock, 
          item.id_wariantu, 
          item.id_produktu, 
          item.reference, 
          item.ean13, 
          item.cena_wariant,
          item.opcje, 
          item.stan_magazynowy, 
          item.cena_produktu,
          item.nazwa_produktu,
          item.cena_sprzedazy_brutto,
          item.cena_zakupu_netto,
          item.cena_zakupu_brutto,
          item.grupa_towarowa // Dodano wartość grupa_towarowa
        );
        
        const placeholders = [];
        // Zwiększono liczbę placeholderów do 14
        for (let j = 0; j < 14; j++) { 
          placeholders.push(`$${valueCounter++}`);
        }
        valueStrings.push(`(${placeholders.join(', ')})`);
      }

      // Wykonanie masowego wstawienia
      const query = `
        INSERT INTO stan_magazynowy (
          id_stock, id_wariantu, id_produktu, reference, ean13, cena_wariant, opcje, stan_magazynowy, 
          cena_produktu, nazwa_produktu, cena_sprzedazy_brutto, cena_zakupu_netto, cena_zakupu_brutto, grupa_towarowa -- Dodano kolumnę grupa_towarowa
        ) VALUES ${valueStrings.join(', ')}
      `;
      
      await client.query(query, values);
    }
    
    console.log(`Zapisano ${updatedStanMagazynowy.length} rekordów do bazy danych w jednej operacji`);
  } catch (err) {
    console.error("Error while updating database:", err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
