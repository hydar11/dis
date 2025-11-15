require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');
const initTelegramCommands = require('./telegram-commands');
const { APP_VERSION } = require('./version');
const { ethers } = require('ethers');

// Subgraph query function (same as server.js)
const SUBGRAPH_URL = process.env.SUBGRAPH_URL;
const API_BASE_URL = process.env.API_BASE_URL;

async function querySubgraph(query, variables = {}) {
  const response = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const result = await response.json();
  if (result.errors) throw new Error(result.errors[0].message);
  return result.data;
}

// ETH price fetching with multiple API fallbacks
async function getEthToUsdRate() {
  let ethToUsdRate = 0;
  
  // Primary API: Binance
  try {
    const binanceResponse = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    if (!binanceResponse.ok) {
      throw new Error(`Binance API error: ${binanceResponse.status}`);
    }
    const binanceData = await binanceResponse.json();
    ethToUsdRate = parseFloat(binanceData.price) || 0;
    if (ethToUsdRate > 0) {
      return ethToUsdRate;
    }
    throw new Error('Invalid price from Binance');
  } catch (error) {
    console.error(` Binance failed:`, error.message);
  }
  
  // Secondary API: CoinGecko
  try {
    const coingeckoResponse = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    if (!coingeckoResponse.ok) {
      throw new Error(`CoinGecko API error: ${coingeckoResponse.status}`);
    }
    const coingeckoData = await coingeckoResponse.json();
    ethToUsdRate = parseFloat(coingeckoData?.ethereum?.usd) || 0;
    if (ethToUsdRate > 0) {
      return ethToUsdRate;
    }
    throw new Error('Invalid price from CoinGecko');
  } catch (error) {
    console.error(` CoinGecko failed:`, error.message);
  }
  
  // No hardcoded fallback - return 0 if both APIs fail
  return 0;
}

// Fetch orderbook for an item (aggregated price levels)
async function fetchOrderbook(itemId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/orderbook/${itemId}`, {
      headers: { 'X-App-Version': APP_VERSION }
    });
    if (!response.ok) {
      throw new Error(`Orderbook API error: ${response.status}`);
    }
    const data = await response.json();
    return data.asks || [];
  } catch (error) {
    console.error(` Failed to fetch orderbook for item ${itemId}:`, error.message);
    return [];
  }
}

// Fetch listings for an item with owner info
async function fetchListingsForItem(itemId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/listings?itemId=${itemId}`, {
      headers: { 'X-App-Version': APP_VERSION }
    });
    if (!response.ok) {
      throw new Error(`Listings API error: ${response.status}`);
    }
    const listings = await response.json();
    return listings || [];
  } catch (error) {
    console.error(` Failed to fetch listings for item ${itemId}:`, error.message);
    return [];
  }
}

// Fetch PNL data for a user address
async function fetchUserPnL(address, itemId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/user-pnl/${address}`, {
      headers: { 'X-App-Version': APP_VERSION }
    });
    if (!response.ok) {
      throw new Error(`PNL API error: ${response.status}`);
    }
    const data = await response.json();
    const itemPosition = data.positions?.find(p => p.itemId === itemId.toString());
    return itemPosition || null;
  } catch (error) {
    console.error(` Failed to fetch PNL for ${address}:`, error.message);
    return null;
  }
}

// Fetch inventory balance for a user
async function fetchUserInventory(address, itemId) {
  try {
    const response = await fetch(`https://gigaverse.io/api/importexport/balances/${address}`);
    if (!response.ok) {
      throw new Error(`Inventory API error: ${response.status}`);
    }
    const data = await response.json();
    const entities = data.entities || [];
    const item = entities.find(i => i.ID_CID === itemId.toString());
    return item ? parseInt(item.BALANCE_CID) : 0;
  } catch (error) {
    console.error(` Failed to fetch inventory for ${address}:`, error.message);
    return 0;
  }
}

// Initialize Discord bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Initialize Telegram bot
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let telegramBot = null;
if (TELEGRAM_BOT_TOKEN) {
  try {
    telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    console.log('✅ Telegram bot initialized');
  } catch (error) {
    console.error('❌ Failed to initialize Telegram bot:', error.message);
  }
} else {
  console.warn('⚠️ TELEGRAM_BOT_TOKEN not found - Telegram notifications disabled');
}

// Bot configuration
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // Your server ID
const NOTIFICATION_CHANNEL_ID = process.env.DISCORD_NOTIFICATION_CHANNEL_ID; // Channel for server notifications
const ADMIN_LOG_CHANNEL_ID = process.env.DISCORD_ADMIN_LOG_CHANNEL_ID; // Channel for admin logs

// Telegram helper functions
async function saveTelegramMapping(username, chatId) {
  try {
    if (!supabase) return false;

    const { error } = await supabase
      .from('telegram_mappings')
      .upsert({
        username: username,
        chat_id: chatId,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'username'
      });

    if (error) {
      console.error('Error saving Telegram mapping:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to save Telegram mapping:', error);
    return false;
  }
}

async function getTelegramChatId(username) {
  try {
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('telegram_mappings')
      .select('chat_id')
      .eq('username', username)
      .single();

    if (error || !data) {
      return null;
    }

    return data.chat_id;
  } catch (error) {
    console.error('Failed to get Telegram chat ID:', error);
    return null;
  }
}

// Telegram bot /start command
if (telegramBot) {
  telegramBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;

    if (!username) {
      await telegramBot.sendMessage(chatId, '❌ You need to set a Telegram username first to use this bot.\n\nGo to Settings → Edit Profile → Username');
      return;
    }

    const saved = await saveTelegramMapping(username, chatId);

    if (saved) {
      await telegramBot.sendMessage(
        chatId,
        `Noob you are ready to receive Juiced Alerts`
      );
      console.log(`✅ Telegram user registered: @${username} (${chatId})`);
    } else {
      await telegramBot.sendMessage(chatId, '❌ Registration failed. Please try again later.');
    }
  });

  // Handle errors
  telegramBot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error.message);
  });

  // Initialize Telegram commands for alert management
  initTelegramCommands(telegramBot, supabase);
}

// Discord bot ready event (using clientReady to avoid deprecation warning)
client.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
});

function matchesDiscordMember(member, discordUsername, cleanUsername) {
  const candidates = [
    member.user.username,
    member.user.globalName,
    member.displayName
  ].filter(Boolean);

  return candidates.some(name =>
    name === discordUsername ||
    name === cleanUsername ||
    name.toLowerCase() === cleanUsername.toLowerCase()
  );
}

async function findDiscordMember(discordUsername) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    throw new Error('Guild not found');
  }

  const cleanUsername = discordUsername.replace(/[@\s]/g, '');

  // Try cached members first
  const cachedMember = guild.members.cache.find(m => matchesDiscordMember(m, discordUsername, cleanUsername));
  if (cachedMember) {
    return cachedMember;
  }

  // Fallback: query Discord for this username (limited subset, so it works even when cache is cold)
  try {
    const searchQuery = cleanUsername.slice(0, 32);
    const fetchedMembers = await guild.members.fetch({ query: searchQuery, limit: 5 });
    const matched = fetchedMembers.find(m => matchesDiscordMember(m, discordUsername, cleanUsername));
    if (matched) {
      return matched;
    }
  } catch (error) {
    console.warn(`[DISCORD] Member fetch query failed for ${discordUsername}: ${error.message}`);
  }

  return null;
}

// Function to send DM to user (with optional embed image)
async function sendDirectMessage(discordUsername, message, itemId = null, condition = 'above') {
  try {
    const member = await findDiscordMember(discordUsername);

    if (!member) {
      console.error(`User ${discordUsername} not found in server`);
      return false;
    }

    // If itemId is provided, send embed with image
    if (itemId) {
      const { embed, files } = await buildEmbedWithIcon(message, itemId, condition, 'dm');
      const sendOptions = { embeds: [embed] };
      if (files) {
        sendOptions.files = files;
      }
      await member.send(sendOptions);
    } else {
      // Send plain text message
      await member.send(message);
    }

    return true;
  } catch (error) {
    console.error(`Failed to send DM to ${discordUsername}:`, error.message);
    return false;
  }
}

// Function to find or create private thread for user (with optional embed image)
async function findOrCreatePrivateThread(discordUsername, message, itemId = null, condition = 'above') {
  let member = null;
  let channel = null;
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
      throw new Error('Guild not found');
    }

    member = await findDiscordMember(discordUsername);
    if (!member) {
      console.error(`User ${discordUsername} not found for private thread`);
      return false;
    }

    channel = guild.channels.cache.get(NOTIFICATION_CHANNEL_ID);
    if (!channel) {
      throw new Error('Notification channel not found');
    }

    // Check bot permissions
    const botMember = guild.members.cache.get(client.user.id);
    const permissions = botMember.permissionsIn(channel);
    if (!permissions.has('CreatePrivateThreads')) {
      console.warn(`⚠️ Bot missing CreatePrivateThreads permission in channel ${channel.name}`);
      return await sendChannelAlert(channel, member, message, itemId, condition);
    }

    // Look for existing private thread for this user
    const existingThread = channel.threads.cache.find(thread =>
      thread.name === `Alert for ${member.displayName}` &&
      thread.type === 12 && // GUILD_PRIVATE_THREAD
      !thread.archived
    );

    let thread;
    if (existingThread) {
      thread = existingThread;
    } else {
      try {
        // Try private thread first
        thread = await channel.threads.create({
          name: `Alert for ${member.displayName}`,
          type: 12, // GUILD_PRIVATE_THREAD
          invitable: false,
          autoArchiveDuration: 1440 // 24 hours
        });
      } catch (privateError) {
        console.error(` Private thread failed:`, privateError.message);

        // Fallback to public thread if private fails
        try {
          thread = await channel.threads.create({
            name: `Alert for ${member.displayName}`,
            type: 11, // GUILD_PUBLIC_THREAD
            autoArchiveDuration: 1440 // 24 hours
          });
        } catch (publicError) {
          console.error(` Public thread also failed:`, publicError.message);
          throw publicError;
        }
      }

      // Add the user to the thread
      try {
        await thread.members.add(member.user.id);
      } catch (addError) {
        console.warn(` Unable to add ${member.displayName} to thread:`, addError.message);
      }
    }

    // Send message in the thread (with embed if itemId provided)
    if (itemId) {
      const perms = channel.permissionsFor(client.user.id);
      const canAttach = perms ? perms.has('AttachFiles') : false;
      const { embed, files } = await buildEmbedWithIcon(
        `<@${member.user.id}> ${message}`,
        itemId,
        condition,
        'thread',
        { preferAttachment: canAttach }
      );
      const sendOptions = { embeds: [embed] };
      if (files) {
        sendOptions.files = files;
      }
      await thread.send(sendOptions);
    } else {
      // Send plain text message
      await thread.send(`<@${member.user.id}> ${message}`);
    }

    return true;
  } catch (error) {
    console.error(`Failed to find/create private thread for ${discordUsername}:`, error.message);
    if (channel && member && (error.code === 50013 || /Missing Permissions/i.test(error.message))) {
      const fallbackSent = await sendChannelAlert(channel, member, message, itemId, condition);
      if (fallbackSent) {
        return true;
      }
    }
    return false;
  }
}

const TELEGRAM_ICON_TTL_MS = parseInt(process.env.TELEGRAM_ICON_TTL_MS || '120000', 10);
const telegramIconPayloadCache = new Map(); // key -> { expiresAt, data }

async function getTelegramIconPayload(itemId, condition) {
  const cacheKey = `${itemId}_${condition}`;
  const cached = telegramIconPayloadCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const cacheBuster = Date.now();
  const url = `${API_BASE_URL}/api/telegram-icon/${itemId}?condition=${condition}&v=${cacheBuster}`;

  try {
    const response = await fetch(url, { headers: { 'X-App-Version': APP_VERSION } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const payload = { type: 'buffer', value: buffer };
    telegramIconPayloadCache.set(cacheKey, { expiresAt: Date.now() + TELEGRAM_ICON_TTL_MS, data: payload });
    return payload;
  } catch (error) {
    console.warn(`[TELEGRAM] Icon fetch failed (${error.message}) for ${cacheKey}`);
    if (cached) {
      return cached.data;
    }
    return { type: 'url', value: url };
  }
}

function getConditionColor(condition = 'default') {
  switch (condition) {
    case 'above':
      return 0x10b981; // Green
    case 'below':
      return 0xef4444; // Red
    case 'sold':
      return 0xf59e0b; // Orange
    case 'undercut':
      return 0x8b5cf6;  // Purple 
    default:
      return 0x06b6d4; // Cyan
  }
}

async function buildEmbedWithIcon(description, itemId, condition, attachmentPrefix = 'alert', options = {}) {
  const preferAttachment = options.preferAttachment !== false;
  const embed = new EmbedBuilder()
    .setDescription(description)
    .setColor(getConditionColor(condition))
    .setTimestamp();

  let files = undefined;
  if (itemId) {
    const payload = await getTelegramIconPayload(itemId, condition);
    if (payload.type === 'buffer' && preferAttachment) {
      const attachmentName = `${attachmentPrefix}-${itemId}-${condition}.png`;
      files = [new AttachmentBuilder(payload.value, { name: attachmentName })];
      embed.setImage(`attachment://${attachmentName}`);
    } else if (payload.value) {
      embed.setImage(payload.value);
    }
  }

  return { embed, files };
}

async function sendChannelAlert(channel, member, message, itemId, condition) {
  try {
    const perms = channel.permissionsFor(client.user.id);
    if (!perms || !perms.has('SendMessages')) {
      console.warn(`⚠️ Bot lacks SendMessages in channel ${channel.name}`);
      return false;
    }

    const canAttach = perms.has('AttachFiles');
    const mentionDescription = `<@${member.user.id}> ${message}`;
    const { embed, files } = await buildEmbedWithIcon(
      mentionDescription,
      itemId,
      condition,
      'channel',
      { preferAttachment: canAttach }
    );
    const options = { embeds: [embed] };
    if (files) {
      options.files = files;
    }
    await channel.send(options);
    return true;
  } catch (error) {
    console.error(`Failed to send fallback channel alert for ${member ? member.displayName : 'unknown'}:`, error.message);
    return false;
  }
}

// Function to send Telegram message with optional image
async function sendTelegramMessage(telegramUsername, message, itemId = null, condition = 'above') {
  try {
    if (!telegramBot) {
      console.error('[TELEGRAM] Bot not initialized');
      return false;
    }

    const chatId = await getTelegramChatId(telegramUsername);

    if (!chatId) {
      console.error(`[TELEGRAM] No chat ID found for username: ${telegramUsername}`);
      console.log(`💡 User needs to start the bot first: https://t.me/${process.env.TELEGRAM_BOT_USERNAME || 'your_bot'}`);
      return false;
    }

    // If itemId is provided, send photo with caption
    if (itemId) {
      const payload = await getTelegramIconPayload(itemId, condition);
      const fileOptions = payload.type === 'buffer'
        ? { filename: `telegram-icon-${itemId}-${condition}.png`, contentType: 'image/png' }
        : undefined;

      await telegramBot.sendPhoto(chatId, payload.value, {
        caption: message,
        parse_mode: 'Markdown'
      }, fileOptions);
      console.log(`[TELEGRAM] ✅ Photo sent successfully to ${telegramUsername}`);
    } else {
      // Send text-only message
      await telegramBot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
      console.log(`[TELEGRAM] ✅ Text message sent successfully to ${telegramUsername}`);
    }

    return true;
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Failed to send message to ${telegramUsername}:`, error);
    console.error(`[TELEGRAM] Error details:`, {
      message: error.message,
      code: error.code,
      response: error.response?.body,
      stack: error.stack
    });
    return false;
  }
}

// Function to send notification (sends BOTH DM and private thread for Discord, or Telegram message)
async function sendNotification(username, message, channel = 'discord', itemId = null, condition = 'above') {
  if (channel === 'telegram') {
    return await sendTelegramMessage(username, message, itemId, condition);
  } else {
    const throttleDelayMs = parseInt(process.env.DISCORD_DM_DELAY_MS || '300', 10);
    if (throttleDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, throttleDelayMs));
    }

    // Discord: Send DM with embed if itemId provided
    const dmSent = await sendDirectMessage(username, message, itemId, condition);

    // Send private thread with embed if itemId provided (always attempt, regardless of DM result)
    const threadSent = await findOrCreatePrivateThread(username, message, itemId, condition);

    // Return true if at least one succeeded
    const success = dmSent || threadSent;

    return success;
  }
}

// Function to log triggered alerts to admin channel
async function logTriggeredAlert(username, alertType, details) {
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    
    const logChannel = guild.channels.cache.get(ADMIN_LOG_CHANNEL_ID); // Use separate admin log channel
    if (!logChannel) return;
    
    const logMessage = `**Alert Triggered**\nUser: **${username}**\nType: **${alertType}**\n${details}`;
    await logChannel.send(logMessage);
  } catch (error) {
    console.error('Failed to log triggered alert:', error);
  }
}

// Function to check and send price alerts (multi-item support)
async function checkPriceAlerts() {
  try {
    // Get all price alerts
    const { data: alerts, error } = await supabase
      .from('notification_alerts')
      .select('*')
      .eq('alert_type', 'price_alert');
    
    if (error) throw error;
    
    // Get current item floor prices and ETH to USD rate
    const [itemsFloorData, ethToUsdRate] = await Promise.all([
      fetch('https://gigaverse.io/api/marketplace/item/floor/all').then(res => res.json()),
      getEthToUsdRate()
    ]);
    const orderbookCache = new Map();
    const getOrderbookForItem = async (itemId) => {
      if (orderbookCache.has(itemId)) {
        return orderbookCache.get(itemId);
      }
      const book = await fetchOrderbook(itemId);
      orderbookCache.set(itemId, book);
      return book;
    };
    
    // Helper function to convert wei to ETH then to USD
    function toNumber(bigDecimalStr) {
      return parseFloat(bigDecimalStr || '0');
    }
    
    for (const alert of alerts) {
      const selectedItems = alert.item_ids || [];
      const triggeredItems = [];
      const persistentAlert = alert.remove_after_trigger === false;

      for (const selectedItem of selectedItems) {
        // Remove the skip logic - persistent alerts should trigger every time the condition is met
        // The triggered_once flag is kept for display/tracking purposes only

        const floorItem = itemsFloorData.entities?.find(item =>
          item.GAME_ITEM_ID_CID === parseInt(selectedItem.id)
        );

        if (!floorItem || !floorItem.ETH_MINT_PRICE_CID) {
          continue;
        }

        const floorPriceETH = toNumber(floorItem.ETH_MINT_PRICE_CID) / 1e18;
        const currentPriceUSD = floorPriceETH * ethToUsdRate;

        const priceCondition = selectedItem.price_condition || alert.price_condition || 'below';

        const usdTargetSource = selectedItem.target_price_usd ?? alert.target_price_usd;
        const ethTargetSource = selectedItem.target_price_eth ?? alert.target_price_eth;

        const usdTarget = usdTargetSource !== null && usdTargetSource !== undefined ? parseFloat(usdTargetSource) : NaN;
        const ethTarget = ethTargetSource !== null && ethTargetSource !== undefined ? parseFloat(ethTargetSource) : NaN;

        const usdValid = !Number.isNaN(usdTarget) && usdTarget > 0;
        const ethValid = !Number.isNaN(ethTarget) && ethTarget > 0;

        if (!usdValid && !ethValid) {
          continue;
        }

        const usdTriggered = usdValid && (
          (priceCondition === 'above' && currentPriceUSD >= usdTarget) ||
          (priceCondition === 'below' && currentPriceUSD <= usdTarget)
        );

        const ethTriggered = ethValid && (
          (priceCondition === 'above' && floorPriceETH >= ethTarget) ||
          (priceCondition === 'below' && floorPriceETH <= ethTarget)
        );

        if (!usdTriggered && !ethTriggered) {
          continue;
        }

        // NEW: Check minimum amount condition if specified
        const minAmount = selectedItem.min_amount || alert.min_amount;
        if (minAmount && minAmount > 0) {
          // Fetch orderbook to count items at trigger price
          const orderbook = await getOrderbookForItem(selectedItem.id);

          let itemCountAtTrigger = 0;

          if (priceCondition === 'below') {
            // Count items at or below the trigger price
            const targetPriceETH = ethValid ? ethTarget : (usdValid ? usdTarget / ethToUsdRate : 0);
            itemCountAtTrigger = orderbook
              .filter(ask => ask.price <= targetPriceETH)
              .reduce((sum, ask) => sum + ask.amount, 0);
          } else if (priceCondition === 'above') {
            // Count items at or above the trigger price
            const targetPriceETH = ethValid ? ethTarget : (usdValid ? usdTarget / ethToUsdRate : 0);
            itemCountAtTrigger = orderbook
              .filter(ask => ask.price >= targetPriceETH)
              .reduce((sum, ask) => sum + ask.amount, 0);
          }

          if (itemCountAtTrigger < minAmount) {
            continue;
          }

          // Store count for logging purposes
          selectedItem._itemCountAtTrigger = itemCountAtTrigger;
        }

        triggeredItems.push({
          name: selectedItem.name,
          priceCondition,
          usdTarget: usdValid ? usdTarget : null,
          ethTarget: ethValid ? ethTarget : null,
          currentPriceUSD,
          currentPriceETH: floorPriceETH,
          usdTriggered,
          ethTriggered,
          originalItem: selectedItem
        });
      }

      if (triggeredItems.length === 0) {
        continue;
      }

      const item = triggeredItems[0];
      const conditionLabel = item.priceCondition === 'above' ? 'Above' : 'Below';

      // Helper function to format ETH with appropriate decimals and remove trailing zeros
      const formatETH = (ethValue) => {
        let formatted;
        if (ethValue >= 0.01) formatted = ethValue.toFixed(4);
        else if (ethValue >= 0.001) formatted = ethValue.toFixed(5);
        else if (ethValue >= 0.0001) formatted = ethValue.toFixed(6);
        else formatted = ethValue.toFixed(8);

        // Remove trailing zeros after decimal point
        return formatted.replace(/\.?0+$/, '');
      };

      const messageLines = [];
      if (item.usdTarget) {
        const prefix = item.usdTriggered ? '✅' : '•';
        messageLines.push(`${prefix} USD target: $${item.usdTarget.toFixed(2)} (current $${item.currentPriceUSD.toFixed(2)})`);
      }
      if (item.ethTarget) {
        const prefix = item.ethTriggered ? '✅' : '•';
        messageLines.push(`${prefix} ETH target: Ξ${formatETH(item.ethTarget)} (current Ξ${formatETH(item.currentPriceETH)})`);
      }
      const messageBody = messageLines.join('\n');
      const message = `🚨 **Price Alert** 🚨\n**${item.name}** hit ${conditionLabel} target\n${messageBody}`;

      // Route notification based on channel
      const username = alert.notification_channel === 'telegram' ? alert.telegram_username : alert.discord_username;
      const channel = alert.notification_channel || 'discord';
      const itemId = item.originalItem.id;
      const condition = item.priceCondition; // 'above' or 'below'

      const sent = await sendNotification(username, message, channel, itemId, condition);
      if (!sent) {
        console.error(` Failed to send notification to ${username} (channel: ${channel}) - removing invalid alert`);
        await supabase
          .from('notification_alerts')
          .delete()
          .eq('id', alert.id);
        continue;
      }
      console.log(`[PRICE ALERT] Sent to ${username}`);


      const logDetails = [
        `Item: **${item.name}**`,
        `Condition: **${conditionLabel}**`,
        item.usdTarget ? `USD target: **$${item.usdTarget.toFixed(2)}** (current $${item.currentPriceUSD.toFixed(2)})` : null,
        item.ethTarget ? `ETH target: **Ξ${formatETH(item.ethTarget)}** (current Ξ${formatETH(item.currentPriceETH)})` : null,
        `Persistence: **${persistentAlert ? 'Keeps until deleted' : 'Auto-remove'}**`
      ].filter(Boolean).join('\n');

      const logUsername = username || alert.discord_username || alert.telegram_username || 'unknown';
      await logTriggeredAlert(
        logUsername,
        'Price Alert',
        logDetails
      );

      if (persistentAlert) {
        const nowIso = new Date().toISOString();
        const updatedItems = (alert.item_ids || []).map(existingItem => {
          if (String(existingItem.id) === String(item.originalItem.id)) {
            return {
              ...existingItem,
              triggered_once: true,
              last_triggered_at: nowIso
            };
          }
          return existingItem;
        });

        await supabase
          .from('notification_alerts')
          .update({ item_ids: updatedItems })
          .eq('id', alert.id);
      } else {
        await supabase
          .from('notification_alerts')
          .delete()
          .eq('id', alert.id);
      }
    }
  } catch (error) {
    console.error('Error checking price alerts:', error);
  }
}

// Function to check and send listing sold notifications (multi-listing support)
async function checkListingSoldNotifications() {
  try {
    // Get all listing alerts
    const { data: alerts, error } = await supabase
      .from('notification_alerts')
      .select('*')
      .eq('alert_type', 'listing_alert');
    
    if (error) throw error;
    
    // Get ETH to USD rate with fallback
    const ethToUsdRate = await getEthToUsdRate();
    
    // Process alerts sequentially to avoid race conditions
    for (let i = alerts.length - 1; i >= 0; i--) {
      const alert = alerts[i];
      let alertModified = false;
      let selectedListings = [...(alert.listing_ids || [])]; // Create a copy
      let invalidUser = false;

      for (let j = selectedListings.length - 1; j >= 0; j--) {
        const selectedListing = selectedListings[j];
        try {
          // Check listing status via subgraph (same as main app)
          const query = `
            query GetListing($listingId: String!) {
              listing(id: $listingId) {
                id
                amount
                amountRemaining
                pricePerItemETH
                status
                isActive
                owner { id }
                transfers {
                  amount
                  totalValueETH
                  transferredTo { id }
                }
              }
            }
          `;

          const data = await querySubgraph(query, { listingId: selectedListing.id });
          const listing = data.listing;
          if (!listing) {
            // Listing doesn't exist anymore, remove it
            selectedListings.splice(j, 1);
            alertModified = true;
            continue;
          }

          // Check if listing was canceled by owner vs sold to someone else
          let wasCanceledByOwner = false;
          // Prefer explicit status/isActive signals when available
          if (typeof listing.status === 'string' && listing.status.toUpperCase().includes('CANCEL')) {
            wasCanceledByOwner = true;
          } else if (listing.isActive === false && (listing.amountRemaining === listing.amount)) {
            // In some subgraphs, canceled listings are inactive and have full amount remaining
            wasCanceledByOwner = true;
          } else if (listing.transfers && listing.transfers.length > 0) {
            // Heuristic: last transfer back to owner indicates cancellation
            const recentTransfer = listing.transfers[listing.transfers.length - 1];
            wasCanceledByOwner = recentTransfer.transferredTo.id === listing.owner.id;
          }
          const currentRemaining = listing.amountRemaining || 0;
          const isFullySold = currentRemaining == 0;

          let shouldNotify = false;
          let shouldRemoveListing = false;
          let message = '';
          let amountSoldSinceLastCheck = 0; // Initialize outside the blocks

          // Step 1: Evaluate if the listing was canceled by the owner (regardless of amount remaining).
          if (wasCanceledByOwner) {
            shouldRemoveListing = true;
            shouldNotify = false; // Explicitly ensure no notification for cancellations
            console.warn(`Listing ${selectedListing.id} canceled by owner. Removing alert entry.`);

          // Step 2: If not canceled, evaluate if it was sold.
          } else {
            // Get the last known remaining amount (stored when alert was created or last updated)
            const lastKnownRemaining = selectedListing.last_remaining_amount || selectedListing.amount || 0;
            
            // Calculate how many items were sold since last check
            amountSoldSinceLastCheck = lastKnownRemaining - currentRemaining;
            
            const notificationTypes = selectedListing.notification_types || selectedListing.notification_type || ['all_trade'];
            const typesArray = Array.isArray(notificationTypes) ? notificationTypes : [notificationTypes];
            
            if ((typesArray.includes('all_trade') || typesArray.includes('both')) && amountSoldSinceLastCheck > 0) {
              const priceUSD = (selectedListing.price * ethToUsdRate).toFixed(2);
              const priceETH = selectedListing.price.toFixed(6).replace(/\.?0+$/, '');
              message = `💰 **Listing Sale** 💰\n**${selectedListing.item_name}**\namount sold: x**${amountSoldSinceLastCheck}**\nprice: **${priceETH} ETH** ( $${priceUSD} )\nremaining: x **${currentRemaining}**`;
              shouldNotify = true;



              if (isFullySold) {
                shouldRemoveListing = true;
              }
            }

            if ((typesArray.includes('sold_out') || typesArray.includes('both')) && isFullySold) {
              const totalUSD = (selectedListing.amount * selectedListing.price * ethToUsdRate).toFixed(2);
              const totalETH = (selectedListing.amount * selectedListing.price).toFixed(6).replace(/\.?0+$/, '');
              message = `✅ **Listing Complete** ✅\n**${selectedListing.item_name}** - fully sold!\namount: **${selectedListing.amount}**\nreceive: **${totalETH} ETH** ( **$${totalUSD}** )`;
              shouldNotify = true;
              shouldRemoveListing = true;
            }
          }
          
          // Step 3: Perform actions based on the flags set in steps 1 or 2.
          if (shouldNotify) {
            // Route notification based on channel
            const username = alert.notification_channel === 'telegram' ? alert.telegram_username : alert.discord_username;
            const channel = alert.notification_channel || 'discord';
            const itemId = selectedListing.item_id;
            const condition = 'sold'; // Listing sold = use telegram_sold.png background

            const sent = await sendNotification(username, message, channel, itemId, condition);
            if (!sent) {
              console.error(` Failed to send listing notification to ${username} (channel: ${channel}) - marking for removal`);
              invalidUser = true;
              break; // Exit the listing loop for this alert
            }

            // Log triggered alert to admin channel
            const alertTypeStr = isFullySold ? 'Listing Sold Out' : 'Listing Sale';
            const logPriceETH = selectedListing.price.toFixed(6).replace(/\.?0+$/, '');
            const logUsername = username || alert.discord_username || alert.telegram_username || 'unknown';
            await logTriggeredAlert(
              logUsername,
              alertTypeStr,
              `Item: **${selectedListing.item_name}**\nAmount: **${amountSoldSinceLastCheck > 0 ? amountSoldSinceLastCheck : selectedListing.amount}**\nPrice: **${logPriceETH} ETH**`
            );
          }
          
          // Update the last_remaining_amount for future comparisons (only if not canceled)
          if (!wasCanceledByOwner) {
            selectedListing.last_remaining_amount = currentRemaining;
            alertModified = true;
          }
          
          // This now runs for BOTH canceled and sold-out listings.
          if (shouldRemoveListing) {
            // Mark as completed - this is the final trigger
            selectedListing.status = 'completed';
            alertModified = true;
          }
          
        } catch (listingError) {
          console.error(`Error checking listing ${selectedListing.id}:`, listingError);
        }
      }

      // Update database once after processing all listings
      if (invalidUser) {
        // Remove entire alert if user is invalid
        await supabase
          .from('notification_alerts')
          .delete()
          .eq('id', alert.id);
      } else if (alertModified) {
        // Filter out completed listings
        const activeListings = selectedListings.filter(l => l.status !== 'completed');

        if (activeListings.length === 0) {
          // Delete entire alert if no active listings left
          await supabase
            .from('notification_alerts')
            .delete()
            .eq('id', alert.id);
        } else {
          // Update alert with remaining active listings (completed ones removed)
          await supabase
            .from('notification_alerts')
            .update({ listing_ids: activeListings })
            .eq('id', alert.id);
        }
      }
    }
  } catch (error) {
    console.error('Error checking listing sold notifications:', error);
  }
}

// Function to check undercut notifications (batched by item)
async function checkUndercutNotifications() {
  try {
    console.log('Checking undercut notifications...');
    const { data: alerts, error } = await supabase
      .from('notification_alerts')
      .select('*')
      .eq('alert_type', 'listing_alert');

    if (error) throw error;

    const ethToUsdRate = await getEthToUsdRate();

    // Group alerts by item ID for efficient orderbook fetching
    const alertsByItem = {};

    for (const alert of alerts) {
      for (const listing of (alert.listing_ids || [])) {
        const types = Array.isArray(listing.notification_types) ? listing.notification_types : [listing.notification_types || 'sold_out'];

        const status = listing.status || 'active';

        // Simple undercut handler now covers both legacy "undercut" and "undercut_detailed" types
        const hasUndercutType = types.includes('undercut') || types.includes('undercut_detailed');

        if (hasUndercutType && status === 'active') {
          const itemId = listing.item_id;
          if (!itemId) {
            continue;
          }
          if (!alertsByItem[itemId]) {
            alertsByItem[itemId] = [];
          }
          alertsByItem[itemId].push({ alert, listing, types });
        }
      }
    }

    // Process each item's orderbook once
    for (const [itemId, items] of Object.entries(alertsByItem)) {
      const orderbook = await fetchOrderbook(itemId);

      for (const { alert, listing, types } of items) {
        const userPrice = parseFloat(listing.price);
        const undercutListings = orderbook.filter(ask => ask.price < userPrice);

        if (undercutListings.length === 0) {
          continue;
        }

        const totalAmount = undercutListings.reduce((sum, ask) => sum + ask.amount, 0);
        const totalEthValue = undercutListings.reduce((sum, ask) => sum + (ask.amount * ask.price), 0);
        const totalUsdValue = totalEthValue * ethToUsdRate;
        const topUndercuts = undercutListings.slice(0, 3);
        const undercutDetails = topUndercuts
          .map(ask => {
            const priceETH = ask.price.toFixed(6).replace(/\.?0+$/, '');
            return `${ask.amount}x - ${priceETH} ETH ($${(ask.price * ethToUsdRate).toFixed(2)})`;
          })
          .join('\n');

        const userPriceFormatted = userPrice.toFixed(6).replace(/\.?0+$/, '');
        const undercutSumEth = totalEthValue.toFixed(6).replace(/\.?0+$/, '');
        const undercutSumUsd = totalUsdValue.toFixed(2);
        const message = `🪓 **Price Undercut** 🪓
**${listing.item_name}**
Your price: **${userPriceFormatted} ETH** ($${(userPrice * ethToUsdRate).toFixed(2)})
Undercut sum: **${undercutSumEth} ETH** ($${undercutSumUsd})

**${totalAmount} items** below your price:
${undercutDetails}${undercutListings.length > 3 ? `\n...` : ''}`;

        // Route notification based on channel
        const username = alert.notification_channel === 'telegram' ? alert.telegram_username : alert.discord_username;
        const channel = alert.notification_channel || 'discord';
        const listingItemId = listing.item_id;
        const condition = 'undercut'; // Undercut = use telegram_undercat.png background

        const sent = await sendNotification(username, message, channel, listingItemId, condition);

        if (sent) {
          console.log(`[UNDERCUT] Sent to ${username}`);
          const logUserPrice = userPrice.toFixed(6).replace(/\.?0+$/, '');
          const logUsername = username || alert.discord_username || alert.telegram_username || 'unknown';
          await logTriggeredAlert(
            logUsername,
            'Listing Undercut',
            `${listing.item_name} - ${undercutListings.length} listing${undercutListings.length > 1 ? 's' : ''} below ${logUserPrice} ETH`
          );
        } else {
          console.warn(`[UNDERCUT] Failed to notify ${username}`);
          continue;
        }

        // Update status - mark undercut as sent
        const currentStatus = listing.status || 'active';
        const hasSoldOut = types.includes('sold_out');
        const hasAllTrades = types.includes('all_trade') || types.includes('both');
        const shouldRemoveFromDB = !hasSoldOut && !hasAllTrades;
        const newStatus = shouldRemoveFromDB ? 'completed' : 'undercut_sent';

        if (shouldRemoveFromDB) {
          // Remove this specific listing from the alert
          const updatedListings = alert.listing_ids.filter(l => l.id !== listing.id);

          if (updatedListings.length === 0) {
            const { error: deleteError } = await supabase
              .from('notification_alerts')
              .delete()
              .eq('id', alert.id);

            if (deleteError) {
              console.error(` Failed to delete alert ${alert.id}:`, deleteError);
            }
          } else {
            const { error: updateError } = await supabase
              .from('notification_alerts')
              .update({ listing_ids: updatedListings })
              .eq('id', alert.id);

            if (updateError) {
              console.error(` Failed to update alert ${alert.id}:`, updateError);
            }
          }
        } else {
          const updatedListings = alert.listing_ids.map(l =>
            l.id === listing.id ? { ...l, status: newStatus } : l
          );

          const { error: updateError } = await supabase
            .from('notification_alerts')
            .update({ listing_ids: updatedListings })
            .eq('id', alert.id);

          if (updateError) {
            console.error(`[ERROR] Failed to update alert ${alert.id}:`, updateError);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error checking undercut notifications:', error);
  }
}

// Wrapper function to safely run checks with error handling
async function runSafeCheck(checkName, checkFunction) {
  try {
    await checkFunction();
  } catch (error) {
    console.error(` Error in ${checkName}:`, error);
  }
}

// Main monitoring function with bulletproof error handling
async function runMonitoringCycle() {
  try {
    // Run all checks with individual error handling
    await Promise.allSettled([
      runSafeCheck('Price Alerts', checkPriceAlerts),
      runSafeCheck('Listing Notifications', checkListingSoldNotifications),
      runSafeCheck('Undercut Notifications', checkUndercutNotifications)
    ]);
  } catch (error) {
    console.error(' Fatal error in monitoring cycle:', error);
  }
}

// Start monitoring (run every 5 minutes) - can be called multiple times safely
let monitoringInterval = null;
function startNotificationMonitoring() {
  // Clear existing interval if any
  if (monitoringInterval) {
    console.log('Restarting notification monitoring...');
    clearInterval(monitoringInterval);
  } else {
    console.log('Starting notification monitoring...');
  }

  // Run immediately first time
  setTimeout(async () => {
    await runMonitoringCycle();
  }, 5000);

  // Set up interval with robust error handling and timeout
  monitoringInterval = setInterval(async () => {
    // Add timeout to prevent infinite hangs, but don't force exit
    const timeoutId = setTimeout(() => {
      console.error(' TIMEOUT: Monitoring cycle taking too long (>4 minutes), skipping this cycle');
      // Don't force exit - just skip this cycle and continue
    }, 4 * 60 * 1000); // 4 minute timeout

    try {
      await runMonitoringCycle();
    } catch (error) {
      console.error(' Error in monitoring cycle:', error);
      console.error('Stack:', error?.stack || 'No stack trace');
      // Continue despite error
    } finally {
      clearTimeout(timeoutId); // Cancel timeout if completed normally
    }
  }, 5 * 60 * 1000); // 5 minutes

  console.log('Monitoring interval set (every 5 minutes)');
}

// Add reconnection handling with auto-recovery
client.on('disconnect', () => {
  console.warn(' Discord bot disconnected, will attempt to reconnect...');
});

client.on('error', (error) => {
  console.error(' Discord client error:', error);
  console.error('Stack:', error?.stack || 'No stack trace');
  // Don't exit - Discord.js will handle reconnection
});

client.on('shardError', (error) => {
  console.error(' Discord shard error:', error);
  console.error('Stack:', error?.stack || 'No stack trace');
  // Don't exit - Discord.js will handle reconnection
});

client.on('shardReconnecting', () => {
  console.log(' Discord shard reconnecting...');
});

client.on('shardReady', () => {
  console.log(' Discord shard ready');
});

client.on('shardDisconnect', (event) => {
  console.warn(' Discord shard disconnected:', event);
});

client.on('shardResume', () => {
  console.log(' Discord shard resumed');
});

// Add process-level error handlers to prevent exit
process.on('unhandledRejection', (reason, promise) => {
  console.error(' Unhandled Rejection at:', promise, 'reason:', reason);
  console.error('Stack:', reason?.stack || 'No stack trace');
  // Don't exit the process - continue running
});

process.on('uncaughtException', (error) => {
  console.error(' Uncaught Exception:', error);
  console.error('Stack:', error?.stack || 'No stack trace');
  // Don't exit the process - continue running
});

// Prevent process exit
process.on('exit', (code) => {
  console.error(` Process attempting to exit with code ${code} - this should not happen!`);
});

// Handle SIGTERM gracefully but don't exit
process.on('SIGTERM', () => {
  console.warn(' Received SIGTERM - ignoring and continuing to run');
});

// Handle SIGINT gracefully but don't exit
process.on('SIGINT', () => {
  console.warn(' Received SIGINT - ignoring and continuing to run');
});

// Persistent login function with infinite retry
async function loginWithRetry() {
  try {
    console.log(' Attempting to login to Discord...');
    await client.login(DISCORD_BOT_TOKEN);
    console.log(' Successfully logged in to Discord');
  } catch (error) {
    console.error(' Failed to login to Discord:', error);
    console.error('Stack:', error?.stack || 'No stack trace');
    console.log(' Retrying login in 30 seconds...');
    setTimeout(loginWithRetry, 30000);
  }
}

// Handle ready event with monitoring restart (using clientReady to avoid deprecation warning)
client.on('ready', () => {
  console.log(` Discord bot ready as ${client.user.tag}`);
  console.log(` Guild cache: ${client.guilds.cache.size} guilds`);
  console.log(` User: ${client.user.username}#${client.user.discriminator}`);

  // Always restart monitoring on ready (in case of reconnection)
  startNotificationMonitoring();
});

// Login bot and start monitoring
if (DISCORD_BOT_TOKEN) {
  loginWithRetry();
} else {
  console.error(' DISCORD_BOT_TOKEN not found in environment variables');
  console.error(' Bot cannot start without token');
}

// Add heartbeat to keep process alive and monitor health
setInterval(() => {
  const uptime = Math.floor(process.uptime());
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const memUsage = process.memoryUsage();
  const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);

  console.log(`Bot heartbeat - Uptime: ${hours}h ${minutes}m - Status: ${client.ws.status === 0 ? 'Ready' : 'Not Ready'} - Memory: ${memMB}MB`);

  // Check if bot is not ready for more than 5 minutes and attempt reconnect
  if (client.ws.status !== 0) {
    console.warn('⚠️ Bot not in ready state, attempting to reconnect...');
    client.destroy();
    setTimeout(() => loginWithRetry(), 5000);
  }

  // Force garbage collection if available (for memory leak prevention)
  if (global.gc) {
    global.gc();
    console.log('🗑️ Garbage collection triggered');
  }
}, 15 * 60 * 1000); // Every 15 minutes

// Log startup information
console.log(' Discord Bot Starting...');
console.log(` Started at: ${new Date().toISOString()}`);
console.log(` Node version: ${process.version}`);
console.log(` Initial memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);

module.exports = {
  sendNotification,
  sendDirectMessage,
  findOrCreatePrivateThread
};
