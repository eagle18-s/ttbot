require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ DISCORD_TOKEN və CLIENT_ID .env faylında olmalıdır!');
  process.exit(1);
}

// Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Express (Render üçün keep-alive)
const app = express();
app.get('/', (req, res) => res.send('TikTok Discord Bot is running ✅'));
app.listen(PORT, () => console.log(`🌐 Express server ${PORT} portunda işləyir`));

// Slash command qeydiyyatı
const commands = [
  new SlashCommandBuilder()
    .setName('tt')
    .setDescription('TikTok videosunu su nişansız yükləyir')
    .addStringOption(option =>
      option.setName('url')
        .setDescription('TikTok video linki')
        .setRequired(true)
    )
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('⏳ Slash commandlər qeydiyyat olunur...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commandlər uğurla qeydiyyat olundu!');
  } catch (error) {
    console.error('Slash command xətası:', error);
  }
})();

// TikTok linkini yoxlama
function isTikTokUrl(url) {
  return /tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url);
}
// Bu funksiyanı köhnə getTikTokVideo-nun yerinə qoy
async function getTikTokVideo(url) {
  const attempts = [
    // 1. Normal tikwm
    async () => {
      const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.tikwm.com/'
        }
      });
      return await res.json();
    },
    // 2. Bir az fərqli header
    async () => {
      const res = await fetch(`https://tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': '*/*'
        }
      });
      return await res.json();
    }
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      console.log(`Cəhd ${i + 1}...`);
      const data = await attempts[i]();

      if (data && data.code === 0 && data.data) {
        const videoUrl = data.data.hdplay || data.data.play || data.data.wmplay;
        if (videoUrl) {
          return {
            videoUrl,
            title: data.data.title || 'TikTok Video',
            author: data.data.author?.nickname || 'Unknown',
            duration: data.data.duration || 0
          };
        }
      }
    } catch (err) {
      console.log(`Cəhd ${i + 1} uğursuz:`, err.message);
    }

    // Hər cəhddən sonra bir az gözlə
    await new Promise(r => setTimeout(r, 1500));
  }

  throw new Error('Bütün cəhdlər uğursuz oldu. tikwm.com Render IP-ni bloklayır.');
}

      // Boş cavab yoxlaması
      if (!text || text.trim().length === 0) {
        throw new Error('API boş cavab qaytardı');
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('JSON parse xətası (natamam cavab)');
      }

      if (data.code !== 0 || !data.data) {
        throw new Error(data.msg || 'Video məlumatı alınmadı');
      }

      // Prioritet: HD → no watermark → watermarked
      const videoUrl = data.data.hdplay || data.data.play || data.data.wmplay;

      if (!videoUrl) {
        throw new Error('Video linki tapılmadı');
      }

      return {
        videoUrl,
        title: data.data.title || 'TikTok Video',
        author: data.data.author?.nickname || 'Unknown',
        duration: data.data.duration || 0,
        cover: data.data.cover || data.data.origin_cover
      };

    } catch (error) {
      console.log(`⚠️ Cəhd \( {attempt}/ \){retries} uğursuz: ${error.message}`);

      if (attempt === retries) {
        throw new Error(`Video yüklənə bilmədi (${retries} cəhddən sonra): ${error.message}`);
      }

      // Qısa gözləmə
      await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
    }
  }
}

// Videonu yükləyib göndər
async function downloadAndSend(interactionOrMessage, url) {
  const isInteraction = !!interactionOrMessage.isChatInputCommand;

  const reply = async (content, files = []) => {
    try {
      if (isInteraction) {
        if (interactionOrMessage.deferred || interactionOrMessage.replied) {
          return await interactionOrMessage.editReply({ content, files });
        }
        return await interactionOrMessage.reply({ content, files });
      } else {
        return await interactionOrMessage.reply({ content, files });
      }
    } catch (err) {
      console.error('Reply xətası:', err.message);
    }
  };

  try {
    if (isInteraction) {
      await interactionOrMessage.deferReply();
    }

    await reply('⏳ Video yüklənir, bir az gözləyin...');

    const info = await getTikTokVideo(url);

    // Videonu yüklə
    const videoRes = await fetch(info.videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!videoRes.ok) {
      throw new Error('Video faylı yüklənə bilmədi');
    }

    const buffer = await videoRes.buffer();
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);

    // Discord limiti yoxla (təhlükəsizlik üçün 24MB)
    if (buffer.length > 24 * 1024 * 1024) {
      return reply(`⚠️ Video çox böyükdür (**\( {sizeMB} MB**).\nDiscord limiti aşılır.\n\nBirbaşa link:\n \){info.videoUrl}`);
    }

    const fileName = `tiktok_${Date.now()}.mp4`;
    const filePath = path.join(__dirname, fileName);

    fs.writeFileSync(filePath, buffer);

    const attachment = new AttachmentBuilder(filePath, { name: fileName });

    await reply(
      `✅ **\( {info.author}**\n \){info.title}\n⏱️ ${info.duration}s | 📦 ${sizeMB} MB`,
      [attachment]
    );

    // Müvəqqəti faylı sil
    fs.unlinkSync(filePath);

  } catch (error) {
    console.error('❌ Xəta:', error.message);
    await reply(`❌ Xəta baş verdi:\n\`${error.message}\`\n\nYenidən cəhd edin və ya başqa link atın.`);
  }
}

// Slash command handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'tt') {
    const url = interaction.options.getString('url');

    if (!isTikTokUrl(url)) {
      return interaction.reply({
        content: '❌ Düzgün TikTok linki daxil edin!',
        ephemeral: true
      });
    }

    await downloadAndSend(interaction, url);
  }
});

// Mesajda avtomatik link aşkarlama
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const urls = message.content.match(/(https?:\/\/[^\s]+)/g) || [];
  const tiktokUrl = urls.find(url => isTikTokUrl(url));

  if (tiktokUrl) {
    await downloadAndSend(message, tiktokUrl);
  }
});

client.once('ready', () => {
  console.log(`✅ Bot hazırdır: ${client.user.tag}`);
});

client.login(TOKEN);
