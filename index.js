const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');
const { exec: execCb } = require('child_process');
const util = require('util');
const exec = util.promisify(execCb);

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Variáveis de ambiente (configure no Render!)
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = 'v20.0';

// Número do dono (controle de bloqueio)
const OWNER_NUMBER = '98988840390';

// Diretório temporário
const tempDir = path.join(__dirname, 'temp');
if (!(await fs.stat(tempDir).catch(() => false))) {
  await fs.mkdir(tempDir);
}

// Lista de bloqueados (persistência simples via JSON)
const BLOCK_FILE = path.join(__dirname, 'blocked.json');
const blockedUsers = new Set();
(async () => {
  try {
    const data = await fs.readFile(BLOCK_FILE, 'utf8');
    JSON.parse(data).forEach(num => blockedUsers.add(num));
  } catch {}
})();

async function saveBlocked() {
  await fs.writeFile(BLOCK_FILE, JSON.stringify([...blockedUsers]), 'utf8');
}

// Health check para manter vivo no Render
app.get('/health', (req, res) => res.status(200).send('BaChat online!'));

// Webhook principal
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(200);

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;

    // Ignora usuários bloqueados
    if (blockedUsers.has(from)) return res.sendStatus(200);

    // Comandos de texto
    if (message.type === 'text') {
      const text = message.text.body.trim();
      const lowerText = text.toLowerCase();

      // Menu de ajuda
      if (lowerText === '!ajuda' || lowerText === '!menu') {
        const ajuda = `🔥 BaChat - Comandos 🔥\n\n` +
          `!fig + foto/vídeo → Sticker padrão (igual original)\n` +
          `!efig + foto/vídeo → Sticker expandido (preenche tudo)\n` +
          `!baixar [720/1080/max] + link → Baixa vídeo na qualidade escolhida\n` +
          `Link simples → Baixa vídeo otimizado (~720p)\n` +
          `GIF/vídeo curto → Tenta figurinha animada\n` +
          `!block / !unblock / !listblock → Só dono (98988840390) controla bloqueados\n` +
          `!ajuda → Esse menu\n\n` +
          `Manda qualquer coisa pra testar! 🚀`;
        await sendText(from, ajuda);
        return res.sendStatus(200);
      }

      // Comandos de bloqueio (só dono)
      if (from === OWNER_NUMBER) {
        if (lowerText.startsWith('!block ')) {
          const args = text.slice(7).trim().replace(/\D/g, '');
          if (args.length >= 10 && args !== OWNER_NUMBER) {
            blockedUsers.add(args);
            await saveBlocked();
            await sendText(from, `✅ ${args} bloqueado!`);
          } else {
            await sendText(from, 'Número inválido.');
          }
          return res.sendStatus(200);
        }

        if (lowerText.startsWith('!unblock ')) {
          const args = text.slice(9).trim().replace(/\D/g, '');
          if (blockedUsers.delete(args)) {
            await saveBlocked();
            await sendText(from, `🔓 ${args} desbloqueado!`);
          } else {
            await sendText(from, 'Não estava bloqueado.');
          }
          return res.sendStatus(200);
        }

        if (lowerText === '!listblock') {
          const list = blockedUsers.size > 0 ? [...blockedUsers].join('\n') : 'Nenhum bloqueado.';
          await sendText(from, `📋 Bloqueados:\n${list}`);
          return res.sendStatus(200);
        }
      }

      // Download com qualidade
      let quality = 'default';
      let url = null;

      if (lowerText.startsWith('!baixar ')) {
        const parts = text.slice(8).trim().split(/\s+/);
        if (parts.length >= 1) {
          const qStr = parts[0].toLowerCase();
          if (qStr === 'max' || qStr === 'melhor') quality = 'max';
          else if (!isNaN(qStr) && [360, 480, 720, 1080, 1440, 2160].includes(Number(qStr))) quality = Number(qStr);
          url = parts.slice(1).join(' ') || extractUrl(text);
        }
      } else if (isValidUrl(text)) {
        url = text;
        quality = 'default';
      }

      if (url) {
        await handleDownloadVideo(from, url, quality);
        return res.sendStatus(200);
      }
    }

    // Stickers (imagem, vídeo, gif)
    if (['image', 'video', 'gif'].includes(message.type)) {
      const mediaId = message[message.type]?.id;
      if (mediaId) {
        await sendText(from, 'Criando sticker... 🔥');

        const downloadedPath = await downloadMedia(mediaId);

        let mode = 'fig'; // default
        const prevText = change.value.messages?.[change.value.messages.length - 2]?.text?.body?.toLowerCase() || '';
        if (prevText.includes('!efig')) mode = 'efig';

        const isAnimated = message.type === 'gif' || message.type === 'video';
        let stickerResult;

        if (isAnimated) {
          stickerResult = await createAnimatedSticker(downloadedPath, mode);
        } else {
          stickerResult = { path: await createSticker(downloadedPath, mode), animated: false };
        }

        const stickerId = await uploadMedia(stickerResult.path, 'image/webp');
        await sendSticker(from, stickerId);

        const type = stickerResult.animated ? 'animada' : 'estática';
        await sendText(from, `Sticker ${type} pronto! Use !fig ou !efig antes da mídia. 😎`);

        await fs.unlink(downloadedPath).catch(() => {});
        await fs.unlink(stickerResult.path).catch(() => {});
      }
    }

  } catch (err) {
    console.error('Erro no webhook:', err);
  }

  res.sendStatus(200);
});

// Funções auxiliares
async function sendText(to, text) {
  await fetch(`https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });
}

async function sendSticker(to, mediaId) {
  await fetch(`https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'sticker',
      sticker: { id: mediaId }
    })
  });
}

async function downloadMedia(mediaId) {
  const url = `https://graph.facebook.com/${API_VERSION}/${mediaId}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${TOKEN}` } });
  const buffer = await res.buffer();
  const tempPath = path.join(tempDir, `${Date.now()}.tmp`);
  await fs.writeFile(tempPath, buffer);
  return tempPath;
}

async function uploadMedia(filePath, mimeType) {
  const form = new FormData();
  form.append('file', await fs.readFile(filePath), { filename: path.basename(filePath), contentType: mimeType });
  form.append('messaging_product', 'whatsapp');

  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}` },
    body: form
  });

  const data = await res.json();
  if (!data.id) throw new Error('Upload falhou');
  return data.id;
}

async function createSticker(inputPath, mode = 'fig') {
  const outputPath = path.join(tempDir, `${Date.now()}_sticker.webp`);
  const fit = mode === 'efig' ? sharp.fit.cover : sharp.fit.contain;

  await sharp(inputPath)
    .resize(512, 512, { fit, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toFile(outputPath);

  return outputPath;
}

async function createAnimatedSticker(inputPath, mode = 'fig', duration = 10) {
  const outputPath = path.join(tempDir, `${Date.now()}_anim.webp`);
  const filter = mode === 'efig'
    ? ',scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2'
    : ',scale=512:512:force_original_aspect_ratio=increase,pad=512:512:(ow-iw)/2:(oh-ih)/2';

  const cmd = `${ffmpegPath} -i "${inputPath}" -t ${duration} -vf "fps=15${filter},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 -c:v libwebp -quality 75 "${outputPath}" -y`;

  try {
    await exec(cmd);
    const stats = await fs.stat(outputPath);
    if (stats.size > 500 * 1024) throw new Error('Animated grande demais');
    return { path: outputPath, animated: true };
  } catch (e) {
    console.error('Animated falhou, fallback para estático:', e);
    return { path: await createSticker(inputPath, mode), animated: false };
  }
}

async function cutVideo(inputPath, duration = 30) {
  const outputPath = path.join(tempDir, `${Date.now()}_cut.mp4`);
  const cmd = `${ffmpegPath} -i "${inputPath}" -t ${duration} -c:v libx264 -profile:v high -c:a aac -strict -2 "${outputPath}" -y`;
  await exec(cmd);
  return outputPath;
}

async function handleDownloadVideo(to, url, quality = 'default') {
  try {
    let msg = `Baixando vídeo (${quality === 'max' ? 'máxima' : quality === 'default' ? 'otimizada ~720p' : quality + 'p'})... ⏳`;
    await sendText(to, msg);

    const outputPath = path.join(tempDir, `${Date.now()}.mp4`);

    let format = 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]';
    if (quality === 'max') format = 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/best';
    else if (typeof quality === 'number') format = `bestvideo[height<=${quality}][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=${quality}]`;

    const ytdlp = new YTDlp();
    await ytdlp.download(url, { format, output: outputPath, mergeOutputFormat: 'mp4' });

    let finalPath = outputPath;
    let sizeMB = (await fs.stat(finalPath)).size / (1024 * 1024);

    if (sizeMB > 16) {
      await sendText(to, 'Vídeo grande, cortando para 30s... ✂️');
      finalPath = await cutVideo(outputPath);
      sizeMB = (await fs.stat(finalPath)).size / (1024 * 1024);
    }

    const mediaId = await uploadMedia(finalPath, 'video/mp4');

    if (sizeMB <= 16) {
      await sendMedia(to, mediaId, 'video', 'Vídeo baixado! 🎥');
    } else {
      await sendMedia(to, mediaId, 'document', '', 'video_completo.mp4');
      await sendText(to, `Ainda grande (${sizeMB.toFixed(1)} MB), enviado como documento! 📄`);
    }

    await fs.unlink(finalPath).catch(() => {});
    if (finalPath !== outputPath) await fs.unlink(outputPath).catch(() => {});
  } catch (err) {
    console.error('Erro no download:', err);
    await sendText(to, 'Erro ao baixar 😅 Tenta outro link ou qualidade.');
  }
}

async function sendMedia(to, mediaId, type, caption = '', filename = '') {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type,
    [type]: { id: mediaId, ...(caption ? { caption } : {}), ...(filename ? { filename } : {}) }
  };

  await fetch(`https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

app.listen(port, () => {
  console.log(`BaChat rodando na porta ${port} 🔥`);
});