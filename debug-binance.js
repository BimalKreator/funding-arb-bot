const { USDMClient } = require('binance');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: '/root/funding-arb-bot/apps/backend/.env' });

console.log("--- Binance Connection Test ---");
console.log("API Key (First 5 chars):", process.env.BINANCE_API_KEY ? process.env.BINANCE_API_KEY.substring(0, 5) + "..." : "MISSING");
console.log("Testnet Enabled:", process.env.BINANCE_TESTNET);

const client = new USDMClient({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
  baseUrl: 'https://fapi.binance.com', // Force Mainnet URL
});

async function checkBalance() {
  try {
    console.log("\nAttempting to fetch Futures Balance...");
    const result = await client.getBalance();
    const usdt = result.find(b => b.asset === 'USDT');
    
    if (usdt) {
      console.log("✅ SUCCESS! USDT Balance Found:");
      console.log(usdt);
    } else {
      console.log("⚠️ CONNECTED, but USDT wallet not found in response.");
      console.log("Raw Response length:", result.length);
    }
  } catch (error) {
    console.error("\n❌ ERROR FAILED!");
    console.error("Error Message:", error.message);
    if (error.body) {
      console.error("Binance Server Said:", JSON.stringify(error.body, null, 2));
    }
  }
}

checkBalance();
