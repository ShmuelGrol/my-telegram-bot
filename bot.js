// חבילות נדרשות
const TelegramBot = require('node-telegram-bot-api');
const {Translate} = require('@google-cloud/translate').v2;
const crypto = require('crypto');
const fetch = require('node-fetch');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// מפתחות
// טען את קובץ .env
require('dotenv').config();

// קבל את המפתחות מהמשתנים
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ALIEXPRESS_APP_KEY = process.env.ALIEXPRESS_APP_KEY;
const ALIEXPRESS_APP_SECRET = process.env.ALIEXPRESS_APP_SECRET;
const TRACKING_ID = process.env.TRACKING_ID;
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const translate = new Translate({ key: GOOGLE_API_KEY });

const searchCache = new Map();
const CACHE_DURATION = 3600000;

// בדיקת מנוי לערוץ
async function checkChannelMembership(userId) {
    try {
        const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error('שגיאה בבדיקת מנוי:', error);
        return false;
    }
}

// חתימה ל-API
function generateSignature(params, secret) {
    const sorted = Object.keys(params).sort().map(k => k + params[k]).join('');
    return crypto.createHmac('sha256', secret).update(sorted).digest('hex').toUpperCase();
}

// תרגום משופר עם מילון ידני
async function translateWithFallback(text) {
    const manualTranslations = {
        'משקפת לבריכה': 'swimming goggles',
        'משקפי בריכה': 'swimming goggles',
        'משקפת שחייה': 'swimming goggles',
        'משקפי שחייה': 'swimming goggles',
        'צידנית לרכב': 'car cooler',
        'מקרר לרכב': 'car refrigerator',
        'מקרר נייד לרכב': 'portable car refrigerator',
        'מאוורר לעגלת תינוק': 'baby stroller fan',
        'מאוורר עגלת תינוק': 'baby stroller fan',
        'מאוורר עגלה': 'stroller fan'
    };
    
    const lowerText = text.toLowerCase().trim();
    
    // בדיקה אם יש תרגום ידני
    if (manualTranslations[lowerText]) {
        console.log(`🔄 תרגום ידני: "${text}" → "${manualTranslations[lowerText]}"`);
        return manualTranslations[lowerText];
    }
    
    // אחרת השתמש ב-Google Translate
    try {
        const [translation] = await translate.translate(text, 'en');
        console.log(`🔄 תרגום Google: "${text}" → "${translation}"`);
        return translation;
    } catch (error) {
        console.error('שגיאה בתרגום:', error);
        return text;
    }
}

async function translateToHebrew(text) {
    try {
        const [translation] = await translate.translate(text, 'he');
        return translation;
    } catch (error) {
        console.error('שגיאה בתרגום לעברית:', error);
        return text;
    }
}

// ניקוי כותרת
function cleanProductTitle(title) {
    const removeWords = [
        'Free Shipping', 'Hot Sale', 'New', 'Original', 'Promotion',
        'High Quality', 'Best Seller', 'Factory', 'Direct', 'Wholesale',
        '2024', '2025', 'Fast Delivery', 'In Stock'
    ];
    
    let cleaned = title;
    removeWords.forEach(word => {
        cleaned = cleaned.replace(new RegExp(word, 'gi'), '');
    });
    
    cleaned = cleaned.replace(/[|!]/g, '').replace(/\s+/g, ' ').trim();
    
    if (cleaned.length > 60) {
        cleaned = cleaned.substring(0, 57) + '...';
    }
    
    return cleaned;
}

// יצירת קישור מקוצר
async function generateShortLink(url) {
    try {
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
        const params = {
            app_key: ALIEXPRESS_APP_KEY,
            method: 'aliexpress.affiliate.link.generate',
            promotion_link_type: '0',
            source_values: url,
            tracking_id: TRACKING_ID,
            timestamp,
            sign_method: 'hmac-sha256',
        };
        
        params.sign = generateSignature(params, ALIEXPRESS_APP_SECRET);
        const apiUrl = 'https://api-sg.aliexpress.com/sync?' + new URLSearchParams(params);
        
        const res = await fetch(apiUrl);
        const data = await res.json();
        
        const shortLink = data?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links?.promotion_link?.[0]?.promotion_link;
        
        if (shortLink) {
            console.log(`🔗 קישור מקוצר נוצר בהצלחה`);
        }
        
        return shortLink || url;
    } catch (error) {
        console.error('שגיאה ביצירת קישור קצר:', error);
        return url;
    }
}

// בדיקת רלוונטיות מוצר לחיפוש
function isRelevantProduct(productTitle, searchQuery) {
    const title = productTitle.toLowerCase();
    const query = searchQuery.toLowerCase();
    
    // מילות מפתח שמציינות אביזרים (לא המוצר העיקרי)
    const accessoryKeywords = [
        'suitable for', 'replacement', 'case', 'cover', 'cable', 
        'earpads', 'cushion', 'stand', 'adapter', 'charger',
        'compatible with', 'for anker', 'misodiko', 'geekria',
        'protective', 'storage', 'carrying', 'travel case'
    ];
    
    // בדיקה אם זה אביזר
    const isAccessory = accessoryKeywords.some(keyword => title.includes(keyword));
    if (isAccessory) {
        console.log(`🚫 מסנן אביזר: "${productTitle.substring(0, 50)}..."`);
        return false;
    }
    
    // פיצול מילות החיפוש
    const searchWords = query.split(' ').filter(word => word.length > 2);
    
    // בדיקת התאמה של מילות המפתח
    const matchedWords = searchWords.filter(word => title.includes(word));
    const matchPercentage = matchedWords.length / searchWords.length;
    
    // דרישה להתאמה של לפחות 60% מהמילים
    const isRelevant = matchPercentage >= 0.6;
    
    console.log(`${isRelevant ? '✅' : '❌'} רלוונטיות: "${productTitle.substring(0, 50)}..." | התאמה: ${matchedWords.length}/${searchWords.length} (${Math.round(matchPercentage * 100)}%)`);
    
    return isRelevant;
}

// חיפוש עם סינון רלוונטיות ומיון לפי מכירות
async function searchAliExpress(query) {
    const cacheKey = query.toLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log('📋 משתמש בתוצאות מה-cache');
        return cached.data;
    }

    console.log(`🔍 מחפש את המוצרים הטובים ביותר עבור: "${query}"`);
    
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const params = {
        app_key: ALIEXPRESS_APP_KEY,
        method: 'aliexpress.affiliate.product.query',
        page_no: '1',
        page_size: '50',
        keywords: query,
        platform_product_type: 'ALL',
        ship_to_country: 'IL',
        sort: 'LAST_VOLUME_DESC', // מיון לפי מכירות גבוהות
        target_currency: 'USD',
        target_language: 'EN',
        timestamp,
        tracking_id: TRACKING_ID,
        sign_method: 'hmac-sha256',
    };

    params.sign = generateSignature(params, ALIEXPRESS_APP_SECRET);
    const url = 'https://api-sg.aliexpress.com/sync?' + new URLSearchParams(params);
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        console.log('📊 תשובה מ-API:', JSON.stringify(data).substring(0, 300));

        const products = data?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product || [];
        
        console.log(`📦 נמצאו ${products.length} מוצרים גולמיים`);
        
        if (products.length === 0) {
            console.log('❌ לא נמצאו מוצרים');
            return [];
        }

        // שלב 1: סינון מוצרים רלוונטיים בלבד
        console.log('🎯 מסנן מוצרים רלוונטיים...');
        const relevantProducts = products.filter(product => 
            isRelevantProduct(product.product_title, query)
        );
        
        console.log(`✅ נמצאו ${relevantProducts.length} מוצרים רלוונטיים מתוך ${products.length}`);
        
        if (relevantProducts.length === 0) {
            console.log('❌ לא נמצאו מוצרים רלוונטיים');
            return [];
        }

        // שלב 2: מיון המוצרים הרלוונטיים לפי מכירות
        console.log('📊 ממיין לפי מכירות...');
        relevantProducts.sort((a, b) => {
            const salesA = parseInt((a.sales_count || a.lastest_volume || '0').toString().replace(/[^0-9]/g, '')) || 0;
            const salesB = parseInt((b.sales_count || b.lastest_volume || '0').toString().replace(/[^0-9]/g, '')) || 0;
            return salesB - salesA; // מהגבוה לנמוך
        });

        // לוג של המוצרים הרלוונטיים הטובים ביותר
        console.log('🏆 מוצרים רלוונטיים מובילים:');
        relevantProducts.slice(0, 5).forEach((p, i) => {
            const sales = p.sales_count || p.lastest_volume || '0';
            console.log(`${i+1}. ${p.product_title?.substring(0, 40)}...`);
            console.log(`   מכירות: ${sales} | דירוג: ${p.evaluate_rate}`);
        });

        // שלב 3: עיבוד 4 המוצרים הטובים ביותר
        const topProducts = await Promise.all(
            relevantProducts.slice(0, 4).map(async (item, i) => {
                const cleanedTitle = cleanProductTitle(item.product_title);
                
                console.log(`🎯 מוצר מעובד ${i + 1}: "${cleanedTitle}"`);
                
                let hebrewTitle;
                try {
                    hebrewTitle = await translateToHebrew(cleanedTitle);
                } catch (err) {
                    hebrewTitle = cleanedTitle;
                }
                
                let shortLink;
                try {
                    if (item.promotion_link) {
                        shortLink = await generateShortLink(item.promotion_link);
                    } else {
                        shortLink = await generateShortLink(item.product_detail_url);
                    }
                } catch (err) {
                    shortLink = item.promotion_link || item.product_detail_url;
                }
                
                // ניסיון לחלץ מספר מכירות מכל השדות האפשריים
                const sales = item.sales_count || item.lastest_volume || '0';
                let salesNumber = 0;
                if (typeof sales === 'string') {
                    salesNumber = parseInt(sales.replace(/[^0-9]/g, '')) || 0;
                } else {
                    salesNumber = parseInt(sales) || 0;
                }
                
                return {
                    rank: i + 1,
                    title: hebrewTitle,
                    price: parseFloat(item.target_sale_price || item.target_app_sale_price || 0),
                    originalPrice: parseFloat(item.target_original_price || 0),
                    discount: item.discount ? parseInt(item.discount) : null,
                    rating: item.evaluate_rate ? (parseFloat(item.evaluate_rate) / 20).toFixed(1) : '4.0',
                    orders: salesNumber,
                    image: item.product_main_image_url,
                    url: shortLink
                };
            })
        );

        console.log(`🎯 החזרת ${topProducts.length} מוצרים מובילים רלוונטיים`);
        
        searchCache.set(cacheKey, { data: topProducts, timestamp: Date.now() });
        return topProducts;
        
    } catch (error) {
        console.error('❌ שגיאה בחיפוש:', error);
        return [];
    }
}

// תצוגת תוצאות
function createResultMessage(products, originalQuery, translatedQuery) {
    const emojis = ['🥇', '🥈', '🥉', '🏅'];
    let msg = `🔍 <b>תוצאות חיפוש עבור: "${originalQuery}"</b>\n📝 <i>(${translatedQuery})</i>\n\n`;

    products.forEach(p => {
        msg += `${emojis[p.rank - 1]} <b>${p.title}</b>\n`;
        msg += `⭐ דירוג: ${p.rating}/5\n`;
        msg += `🛒 מכירות: ${formatNumber(p.orders)}\n`;
        msg += `💰 מחיר: $${p.price}`;
        if (p.discount) msg += ` <s>$${p.originalPrice}</s> (-${p.discount}%)`;
        msg += `\n🔗 <a href="${p.url}">קישור למוצר</a>\n\n`;
    });

    return msg;
}

// יצירת איקון מדליה
async function createMedalIcon(number, size = 80) {
    const colors = {
        1: { bg: '#FFD700', text: '#000' },
        2: { bg: '#C0C0C0', text: '#000' },
        3: { bg: '#CD7F32', text: '#FFF' },
        4: { bg: '#4169E1', text: '#FFF' }
    };
    
    const color = colors[number] || colors[4];
    
    const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${size/2}" cy="${size/2}" r="${size/2-5}" fill="${color.bg}" stroke="#000" stroke-width="2"/>
        <text x="${size/2}" y="${size/2+15}" font-family="Arial Black" font-size="${size/2}" 
              text-anchor="middle" fill="${color.text}" font-weight="bold">${number}</text>
    </svg>`;
    
    return Buffer.from(svg);
}

// קולאז' תמונות 2x2
async function createImageCollage(products) {
    try {
        console.log('🖼️ מתחיל ליצור קולאז...');
        
        const imagePromises = products.map(async (product, index) => {
            try {
                console.log(`📸 מוריד תמונה ${index + 1}: ${product.image}`);
                const res = await fetch(product.image);
                const buffer = await res.buffer();
                const image = await sharp(buffer).resize(300, 300).toBuffer();
                
                const medalIcon = await createMedalIcon(index + 1);
                
                const imageWithMedal = await sharp(image)
                    .composite([{
                        input: medalIcon,
                        top: 10,
                        left: 10
                    }])
                    .toBuffer();
                
                console.log(`✅ תמונה ${index + 1} מוכנה`);
                return imageWithMedal;
            } catch (err) {
                console.error(`❌ שגיאה בתמונה ${index + 1}:`, err);
                return null;
            }
        });
        
        const images = await Promise.all(imagePromises);
        const validImages = images.filter(img => img !== null);
        
        if (validImages.length === 0) {
            console.log('❌ לא הצליח להוריד אף תמונה');
            return null;
        }
        
        console.log(`🖼️ יוצר קולאז' עם ${validImages.length} תמונות`);
        
        const canvas = sharp({
            create: { width: 600, height: 600, channels: 3, background: '#fff' }
        });

        const composites = [];
        if (validImages[0]) composites.push({ input: validImages[0], top: 0, left: 0 });
        if (validImages[1]) composites.push({ input: validImages[1], top: 0, left: 300 });
        if (validImages[2]) composites.push({ input: validImages[2], top: 300, left: 0 });
        if (validImages[3]) composites.push({ input: validImages[3], top: 300, left: 300 });

        const collage = await canvas.composite(composites).jpeg().toBuffer();
        
        const outputPath = path.join(__dirname, `collage_${Date.now()}.jpg`);
        fs.writeFileSync(outputPath, collage);
        
        console.log(`🎯 קולאז' נשמר בהצלחה`);
        return outputPath;
    } catch (err) {
        console.error('❌ שגיאה ביצירת קולאז\':', err);
        return null;
    }
}

// טיפול בהודעה
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;
    const messageId = msg.message_id;

    if (!text || text.startsWith('/')) return;

    if (!text.startsWith('מצא לי')) {
        if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
            return;
        }
        
        bot.sendMessage(chatId, '📝 יש לכתוב בפורמט "מצא לי..."', {
            reply_markup: {
                remove_keyboard: true
            }
        });
        return;
    }

    // בדיקת מנוי לערוץ
    const isMember = await checkChannelMembership(userId);
    if (!isMember) {
        bot.sendMessage(chatId, `שלום! 
כדי להשתמש בבוט שלנו, עליך קודם להצטרף לערוץ הטלגרם שלנו 
👈 https://t.me/OuTravel2
לאחר ההצטרפות, פשוט רשום "מצא לי…" ואת מה שאתה מחפש 🔍`, {
            reply_to_message_id: messageId,
            reply_markup: {
                inline_keyboard: [[
                    { text: '📢 הצטרף לערוץ', url: 'https://t.me/OuTravel2' }
                ]]
            }
        });
        return;
    }

    const query = text.replace('מצא לי', '').trim();
    if (!query) {
        bot.sendMessage(chatId, '❓ מה לחפש? נסה למשל: "מצא לי כיסא מתקפל"', {
            reply_to_message_id: messageId,
            reply_markup: {
                remove_keyboard: true
            }
        });
        return;
    }

    try {
        // תגובה ראשונית
        const waitMsg = await bot.sendMessage(chatId, '🔍 אני מחפש עבורך את המוצרים הטובים ביותר...', {
            reply_to_message_id: messageId,
            reply_markup: {
                remove_keyboard: true
            }
        });
        
        // תרגום משופר לאנגלית
        const englishQuery = await translateWithFallback(query);
        
        const products = await searchAliExpress(englishQuery);

        if (products.length === 0) {
            await bot.editMessageText(`😕 לא נמצאו תוצאות עבור "${query}"\nנסה חיפוש אחר או ביטוי שונה`, {
                chat_id: chatId,
                message_id: waitMsg.message_id
            });
            return;
        }

        // מחיקת הודעת ההמתנה
        try {
            await bot.deleteMessage(chatId, waitMsg.message_id);
        } catch (error) {
            // לא נורא אם לא הצליח למחוק
        }

        // שליחת קולאז'
        const imagePath = await createImageCollage(products);
        if (imagePath) {
            const message = createResultMessage(products, query, englishQuery);
            
            try {
                await bot.sendPhoto(chatId, imagePath, { 
                    caption: message,
                    parse_mode: 'HTML',
                    reply_to_message_id: messageId
                });
            } catch (err) {
                // אם ההודעה ארוכה מדי
                await bot.sendPhoto(chatId, imagePath, { 
                    caption: `🔍 <b>${query}</b>\n\n📊 4 המוצרים המובילים באליאקספרס`,
                    parse_mode: 'HTML',
                    reply_to_message_id: messageId
                });
                
                await bot.sendMessage(chatId, message, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_to_message_id: messageId
                });
            }
            
            // מחיקת קובץ התמונה אחרי 5 שניות
            setTimeout(() => {
                try {
                    fs.unlinkSync(imagePath);
                    console.log('🗑️ קובץ קולאז\' נמחק');
                } catch (err) {}
            }, 5000);
        } else {
            // אם הקולאז' נכשל - שלח רק טקסט
            const message = createResultMessage(products, query, englishQuery);
            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_to_message_id: messageId
            });
        }

    } catch (err) {
        console.error('❌ שגיאה:', err);
        bot.sendMessage(chatId, '❌ אירעה שגיאה. נסה שוב מאוחר יותר.', {
            reply_to_message_id: messageId,
            reply_markup: {
                remove_keyboard: true
            }
        });
    }
});

// עיצוב מספרים
function formatNumber(num) {
    if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
    return num.toString();
}

// התחלה ועזרה
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `👋 שלום! כתוב "מצא לי ..." ואחפש עבורך באליאקספרס.`, {
        reply_markup: {
            remove_keyboard: true
        }
    });
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, `🛠️ כתוב "מצא לי ..." + מה שאתה רוצה לחפש.`, {
        reply_markup: {
            remove_keyboard: true
        }
    });
});

console.log('🚀 הבוט פועל!');