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
  console.error('DISCORD_TOKEN və CLIENT_ID .env faylında olmalıdır!');
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

// Express (Render keep-alive üçün)
const app = express();
app.get('/', (req, res) => res.send('TikTok Discord Bot is running ✅'));
app.listen(PORT, () => console.log(`Express server ${PORT} portunda işləyir`));

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
    console.log('Slash commandlər qeydiyyat olunur...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commandlər uğurla qeydiyyat olundu!');
  } catch (error) {
    console.error(error);
  }
})();

// TikTok linkini yoxlama
function isTikTokUrl(url) {
  return /tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url);
}

// TikWM API ilə video məlumatını al
async function getTikTokVideo(url) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
  
  const res = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  const data = await res.json();

  if (data.code !== 0 || !data.data) {
    throw new Error(data.msg || 'Video tapılmadı və ya xəta baş verdi');
  }

  // Prioritet: HD → no-watermark → watermarked
  const videoUrl = data.data.hdplay || data.data.play || data.data.wmplay;
  
  if (!videoUrl) {
    throw new Error('Video linki alınmadı');
  }

  return {
    videoUrl,
    title: data.data.title || 'TikTok Video',
    author: data.data.author?.nickname || 'Unknown',
    duration: data.data.duration || 0,
    cover: data.data.cover || data.data.origin_cover
  };
}

// Videonu yükləyib göndər
async function downloadAndSend(interactionOrMessage, url) {
  const isInteraction = interactionOrMessage.isChatInputCommand?.() || false;
  const reply = async (content, files = []) => {
    if (isInteraction) {
      if (interactionOrMessage.deferred || interactionOrMessage.replied) {
        return interactionOrMessage.editReply({ content, files });
      }
      return interactionOrMessage.reply({ content, files, ephemeral: false });
    } else {
      return interactionOrMessage.reply({ content, files });
    }
  };

  try {
    if (isInteraction) await interactionOrMessage.deferReply();

    await reply('⏳ Video yüklənir, bir az gözləyin...');

    const info = await getTikTokVideo(url);
    
    // Videonu müvəqqəti yüklə
    const videoRes = await fetch(info.videoUrl);
    if (!videoRes.ok) throw new Error('Video yüklənə bilmədi');

    const buffer = await videoRes.buffer();
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);

    // Discord limiti yoxla (əksər serverlərdə 25MB)
    if (buffer.length > 24 * 1024 * 1024) {
      return reply(`⚠️ Video çox böyükdür (${sizeMB} MB). Discord limiti aşılır.\nBirbaşa link: ${info.videoUrl}`);
    }

    const fileName = `tiktok_${Date.now()}.mp4`;
    const filePath = path.join(__dirname, fileName);
    fs.writeFileSync(filePath, buffer);

    const attachment = new AttachmentBuilder(filePath, { name: fileName });

    await reply(
      `✅ **\( {info.author}**\n \){info.title}\n⏱️ ${info.duration}s | 📦 ${sizeMB} MB`,
      [attachment]
    );

    // Faylı sil
    fs.unlinkSync(filePath);

  } catch (error) {
    console.error(error);
    await reply(`❌ Xəta: ${error.message}`);
  }
}

// Slash command handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'tt') {
    const url = interaction.options.getString('url');
    if (!isTikTokUrl(url)) {
      return interaction.reply({ content: '❌ Düzgün TikTok linki daxil edin!', ephemeral: true });
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
