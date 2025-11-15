// Telegram Bot Commands for Alert Management
// Handles user interactions for creating and managing alerts via Telegram

const { APP_VERSION } = require('./version');

const ITEMS_PER_PAGE = 10;
const API_BASE_URL = process.env.API_BASE_URL ;

// Helper: Add version header to API requests
function getVersionedHeaders(additionalHeaders = {}) {
  return {
    'X-App-Version': APP_VERSION,
    ...additionalHeaders
  };
}

// Initialize Telegram commands
function initTelegramCommands(telegramBot, supabase) {
  if (!telegramBot) {
    console.warn('⚠️ Telegram bot not provided to telegram-commands');
    return;
  }

  // Helper: Get all tradable items with floor prices
  async function getTradableItemsWithFloorPrices() {
    try {
      const [itemsResponse, detailsResponse, floorResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/api/items`, { headers: getVersionedHeaders() }),
        fetch(`${API_BASE_URL}/api/item-details`, { headers: getVersionedHeaders() }),
        fetch('https://gigaverse.io/api/marketplace/item/floor/all')
      ]);

      const itemIds = await itemsResponse.json();
      const itemDetails = await detailsResponse.json();
      const floorData = await floorResponse.json();

      const floorLookup = {};
      floorData.entities?.forEach(item => {
        if (item.GAME_ITEM_ID_CID && item.ETH_MINT_PRICE_CID) {
          const floorPriceETH = parseFloat(item.ETH_MINT_PRICE_CID) / 1e18;
          floorLookup[item.GAME_ITEM_ID_CID] = floorPriceETH;
        }
      });

      const items = itemIds.map(itemId => {
        const details = itemDetails[itemId];
        const floorPrice = floorLookup[itemId] || 0;
        return {
          id: itemId,
          name: details?.name || 'Item ' + itemId,
          icon: details?.icon,
          floorPrice: floorPrice
        };
      });

      // Sort by floor price (highest first)
      items.sort((a, b) => b.floorPrice - a.floorPrice);

      return items;
    } catch (error) {
      console.error('Error fetching items:', error);
      return [];
    }
  }

  // Helper: Get ETH to USD rate
  async function getEthToUsdRate() {
    try {
      const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
      const data = await response.json();
      return parseFloat(data.price) || 0;
    } catch (error) {
      console.error('Error fetching ETH price:', error);
      return 0;
    }
  }

  // Helper: Get user's Telegram username from chat
  function getTelegramUsername(msg) {
    return msg.from.username;
  }

  telegramBot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;

    const helpMessage = `
🤖 *Gigaverse Alerts Bot*

*How to use:*

1️⃣ Send /start to register
2️⃣ Go to juiced.sh
3️⃣ Create alerts on website
4️⃣ Receive notifications here!

*Available Commands:*

/start - Register to receive notifications
/help - Show this message

---
Create alerts at: juiced.sh
    `;

    await telegramBot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
  });

  console.log('✅ Telegram bot ready (receive-only mode)');
}

module.exports = initTelegramCommands;
