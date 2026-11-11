require('dotenv').config();
const { Client, GatewayIntentBits, AttachmentBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Discord bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Keep-alive (Railway üçün)
app.get('/', (req, res) => res.send('TikTok Bot işləyir ✅'));
app.listen(PORT, () => console.log(`Server ${PORT} portunda işləyir`));

// Slash command qeydiyyatı
const commands = [
  new SlashCommandBuilder()
    .setName('tt')
    .setDescription('TikTok videosunu su nişansız yükləyir')
    .addStringOption(option =>
      option.setName('link')
        .setDescription('TikTok video linki')
        .setRequired(true)
    )
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Slash komandalar qeydiyyat olunur...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Slash komandalar uğurla qeydiyyat olundu');
  } catch (err) {
    console.error('Slash qeydiyyat xətası:', err);
  }
})();

// TikTok video məlumatını almaq
async function getTikTokVideo(url) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;

  const headersList = [
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.tikwm.com/'
    },
    {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Accept': 'application/json'
    },
    {
      'User-Agent': 'TikTok 26.2.0 rv:262018 (iPhone; iOS 16.5; en_US) Cronet',
      'Accept': 'application/json'
    }
  ];

  let lastError = null;

  for (let i = 0; i < headersList.length; i++) {
    try {
      const res = await fetch(apiUrl, {
        method: 'GET',
        headers: headersList[i],
        timeout: 15000
      });

      const text = await res.text();

      if (!text || text.trim().length === 0) {
        throw new Error('API boş cavab qaytardı');
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('JSON parse xətası');
      }

      if (data.code !== 0 || !data.data) {
        throw new Error(data.msg || 'Video tapılmadı');
      }

      // HD üstünlük verilir
      const videoUrl = data.data.hdplay || data.data.play || data.data.wmplay;
      if (!videoUrl) {
        throw new Error('Video linki tapılmadı');
      }

      return {
        videoUrl,
        title: data.data.title || 'TikTok Video',
        author: data.data.author?.nickname || data.data.author || 'Naməlum',
        cover: data.data.cover
      };
    } catch (err) {
      lastError = err;
      console.log(`Cəhd ${i + 1} uğursuz:`, err.message);
      // qısa gözlə
      await new Promise(r => setTimeout(r, 800));
    }
  }

  throw new Error(`Video yüklənə bilmədi (${headersList.length} cəhddən sonra): ${lastError?.message || 'Naməlum xəta'}`);
}

// Video yükləyib Discord-a göndərmək
async function downloadAndSend(interactionOrMessage, url) {
  const isInteraction = !!interactionOrMessage.deferReply;

  try {
    if (isInteraction) {
      await interactionOrMessage.deferReply();
    } else {
      await interactionOrMessage.channel.sendTyping();
    }

    const info = await getTikTokVideo(url);

    // Videonu yüklə
    const videoRes = await fetch(info.videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!videoRes.ok) throw new Error('Video yüklənmədi');

    const buffer = await videoRes.buffer();

    // Discord limiti (təhlükəsiz hədd)
    if (buffer.length > 24 * 1024 * 1024) {
      throw new Error('Video çox böyükdür (24MB-dan artıq). Discord göndərmir.');
    }

    const fileName = `tiktok_${Date.now()}.mp4`;
    const filePath = path.join(__dirname, fileName);
    fs.writeFileSync(filePath, buffer);

    const attachment = new AttachmentBuilder(filePath, { name: fileName });

    const content = `**\( {info.author}**\n \){info.title}`;

    if (isInteraction) {
      await interactionOrMessage.editReply({ content, files: [attachment] });
    } else {
      await interactionOrMessage.reply({ content, files: [attachment] });
    }

    // Faylı sil
    fs.unlinkSync(filePath);

  } catch (err) {
    console.error(err);
    const errorMsg = `Xəta baş verdi: ${err.message}`;
    if (isInteraction) {
      await interactionOrMessage.editReply(errorMsg).catch(() => {});
    } else {
      await interactionOrMessage.reply(errorMsg).catch(() => {});
    }
  }
}

// Slash command
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'tt') {
    const url = interaction.options.getString('link');
    if (!url.includes('tiktok.com') && !url.includes('vt.tiktok.com')) {
      return interaction.reply({ content: 'Düzgün TikTok linki göndərin.', ephemeral: true });
    }
    await downloadAndSend(interaction, url);
  }
});

// Avtomatik link aşkarlama
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const tiktokRegex = /(https?:\/\/(www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+)/gi;
  const matches = message.content.match(tiktokRegex);

  if (matches && matches.length > 0) {
    // yalnız 1 linki götürürük
    await downloadAndSend(message, matches[0]);
  }
});

client.once('ready', () => {
  console.log(`Bot hazırdır: ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
