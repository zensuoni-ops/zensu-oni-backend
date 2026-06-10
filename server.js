import express from 'express';
import cors from 'cors';
import { parseStringPromise } from 'xml2js';
import WebTorrent from 'webtorrent';
import ffmpeg from 'fluent-ffmpeg';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const client = new WebTorrent();

app.use(cors());
app.use(express.json());

// ── Keep-alive ────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Helpers ───────────────────────────────────────────────

function extractSeasonNumber(title) {
  const match = title.match(/(\d+)(?:st|nd|rd|th)\s+season/i)
    || title.match(/season\s*(\d+)/i);
  return match ? parseInt(match[1]) : 1;
}

function cleanBaseTitle(title) {
  return title
    .replace(/\d+(st|nd|rd|th)\s+season.*/i, '')
    .replace(/season\s*\d+.*/i, '')
    .replace(/part\s*\d+.*/i, '')
    .replace(/cour\s*\d+.*/i, '')
    .replace(/\s*:\s*.*$/, '')
    .trim();
}

async function resolveAnimeTitle(animeName) {
  const query = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        title { romaji english native }
        synonyms
      }
    }
  `;
  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { search: animeName } })
    });
    const data = await response.json();
    const media = data?.data?.Media;
    return {
      english: media?.title?.english || null,
      romaji: media?.title?.romaji || null,
      synonyms: media?.synonyms || [],
      original: animeName
    };
  } catch {
    return {
      english: null,
      romaji: null,
      synonyms: [],
      original: animeName
    };
  }
}

// Extract Nyaa torrent ID from URL
function extractNyaaId(url) {
  const match = url?.match(/nyaa\.si\/(?:view|download)\/(\d+)/);
  return match ? match[1] : null;
}

// ── Search ────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const { anime, episode, type } = req.query;

  if (!anime || !episode) {
    return res.status(400).json({
      error: 'Missing anime or episode parameter'
    });
  }

  try {
    const epNum = parseInt(episode);
    const seasonNum = extractSeasonNumber(anime);
    const isDub = (type || 'sub').toLowerCase() === 'dub';

    const sxeFormat = `S${String(seasonNum).padStart(2,'0')}E${String(epNum).padStart(2,'0')}`;
    const epPadded = String(epNum).padStart(2, '0');

    const titles = await resolveAnimeTitle(anime);
    const englishClean = titles.english ? cleanBaseTitle(titles.english) : null;
    const romajiClean = titles.romaji ? cleanBaseTitle(titles.romaji) : null;
    const originalClean = cleanBaseTitle(anime);

    const queries = [];

    if (isDub) {
      if (englishClean) {
        queries.push(`${englishClean} ${sxeFormat} English Dub`);
        queries.push(`Yameii ${englishClean} ${sxeFormat}`);
        queries.push(`${englishClean} ${sxeFormat} Dual Audio`);
        queries.push(`${englishClean} ${sxeFormat} Dub`);
      }
      if (romajiClean) {
        queries.push(`${romajiClean} ${sxeFormat} English Dub`);
        queries.push(`${romajiClean} ${sxeFormat} Dual Audio`);
      }
      queries.push(`${originalClean} ${sxeFormat} English Dub`);
      queries.push(`${originalClean} ${sxeFormat} Dual Audio`);
    } else {
      if (englishClean) {
        queries.push(`SubsPlease ${englishClean} ${epPadded}`);
        queries.push(`${englishClean} ${sxeFormat} 1080p`);
        queries.push(`${englishClean} ${sxeFormat}`);
        queries.push(`${englishClean} - ${sxeFormat}`);
      }
      if (romajiClean) {
        queries.push(`SubsPlease ${romajiClean} ${epPadded}`);
        queries.push(`${romajiClean} ${sxeFormat} 1080p`);
        queries.push(`${romajiClean} ${sxeFormat}`);
      }
      for (const syn of titles.synonyms.slice(0, 3)) {
        const synClean = cleanBaseTitle(syn);
        queries.push(`SubsPlease ${synClean} ${epPadded}`);
        queries.push(`${synClean} ${sxeFormat}`);
      }
      queries.push(`SubsPlease ${originalClean} ${epPadded}`);
      queries.push(`${originalClean} ${sxeFormat}`);
      queries.push(`${originalClean} ${epPadded}`);
    }

    for (const query of queries) {
      try {
        const nyaaUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=1_2&f=0`;
        const response = await fetch(nyaaUrl);
        const xml = await response.text();
        const result = await parseStringPromise(xml);
        const items = result?.rss?.channel?.[0]?.item;

        if (items && items.length > 0) {
          const qualities = {};

          const sorted = items.sort((a, b) => {
            const seedsA = parseInt(a['nyaa:seeders']?.[0] || 0);
            const seedsB = parseInt(b['nyaa:seeders']?.[0] || 0);
            return seedsB - seedsA;
          });

          for (const item of sorted) {
            const title = item.title[0];
            const magnet = item['nyaa:magnetLink']?.[0] || item.link?.[0];
            const link = item.link?.[0] || '';
            const seeders = parseInt(item['nyaa:seeders']?.[0] || 0);
            const nyaaId = extractNyaaId(link);

            const entry = {
              magnet,
              nyaaId,
              torrentUrl: nyaaId
                ? `https://nyaa.si/download/${nyaaId}.torrent`
                : null,
              streamUrl: `/stream?magnet=${encodeURIComponent(magnet)}`,
              seeders
            };

            if (title.includes('1080p') && !qualities['1080p']) {
              qualities['1080p'] = entry;
            } else if (title.includes('720p') && !qualities['720p']) {
              qualities['720p'] = entry;
            } else if (title.includes('480p') && !qualities['480p']) {
              qualities['480p'] = entry;
            } else if (title.includes('360p') && !qualities['360p']) {
              qualities['360p'] = entry;
            }
          }

          if (Object.keys(qualities).length === 0) {
            const best = sorted[0];
            const mag = best['nyaa:magnetLink']?.[0] || best.link?.[0];
            const lnk = best.link?.[0] || '';
            const nId = extractNyaaId(lnk);
            qualities['default'] = {
              magnet: mag,
              nyaaId: nId,
              torrentUrl: nId
                ? `https://nyaa.si/download/${nId}.torrent`
                : null,
              streamUrl: `/stream?magnet=${encodeURIComponent(mag)}`,
              seeders: parseInt(best['nyaa:seeders']?.[0] || 0)
            };
          }

          const defaultQ =
            qualities['480p'] ||
            qualities['720p'] ||
            qualities['1080p'] ||
            Object.values(qualities)[0];

          return res.json({
            title: sorted[0].title[0],
            matchedQuery: query,
            resolvedTitle: englishClean || romajiClean || originalClean,
            qualities,
            defaultMagnet: defaultQ.magnet,
            defaultTorrentUrl: defaultQ.torrentUrl,
            streamUrl: defaultQ.streamUrl
          });
        }
      } catch {
        continue;
      }
    }

    res.status(404).json({
      error: 'Episode not found on Nyaa.si',
      resolvedAs: { english: englishClean, romaji: romajiClean },
      triedQueries: queries.slice(0, 5)
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Torrent File Proxy ────────────────────────────────────
// Proxies .torrent files from Nyaa.si to avoid CORS issues
// Torrent files are tiny (1-50KB) - no storage concerns
app.get('/torrent-proxy', async (req, res) => {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid torrent ID' });
  }

  try {
    const torrentUrl = `https://nyaa.si/download/${id}.torrent`;
    const response = await fetch(torrentUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ZensuOni/1.0)'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Nyaa returned ${response.status}`
      });
    }

    const buffer = await response.arrayBuffer();

    res.setHeader('Content-Type', 'application/x-bittorrent');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Stream ────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  const { magnet } = req.query;
  if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

  const decoded = decodeURIComponent(magnet);

  // Destroy ALL other torrents first to prevent wrong episode bug
  const toDestroy = client.torrents.filter(t => t.magnetURI !== decoded);
  toDestroy.forEach(t => {
    try { t.destroy(); } catch {}
  });

  // Reuse if already loaded
  const existing = client.torrents.find(t => t.magnetURI === decoded);
  if (existing) {
    const file = existing.files
      .sort((a, b) => b.length - a.length)
      .find(f => f.name.match(/\.(mkv|mp4|avi)$/i));
    if (file) return transcodeAndStream(file, req, res);
  }

  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({
        error: 'Stream timeout - no peers found. Try a different quality.'
      });
    }
  }, 60000);

  client.add(decoded, (torrent) => {
    clearTimeout(timeout);

    torrent.files.forEach(f => f.deselect());

    const file = torrent.files
      .sort((a, b) => b.length - a.length)
      .find(f => f.name.match(/\.(mkv|mp4|avi)$/i));

    if (!file) {
      return res.status(404).json({
        error: 'No video file found in torrent'
      });
    }

    file.select();
    transcodeAndStream(file, req, res);
  });
});

function transcodeAndStream(file, req, res) {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Transfer-Encoding', 'chunked');

  const isMkv = file.name.toLowerCase().endsWith('.mkv');
  const stream = file.createReadStream();
  const command = ffmpeg(stream);

  if (isMkv) {
    command.inputFormat('matroska');
  }

  command
    .outputOptions([
      '-c:v copy',
      '-c:a aac',
      '-c:s mov_text',
      '-f mp4',
      '-movflags frag_keyframe+empty_moov+default_base_moof'
    ])
    .on('start', (cmd) => {
      console.log('FFmpeg started:', cmd);
    })
    .on('error', (err) => {
      console.error('FFmpeg error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Transcoding failed: ' + err.message });
      }
    })
    .pipe(res, { end: true });
}

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Zensu-Oni backend running on port ${PORT}`);
  console.log(`FFmpeg path: ${ffmpegInstaller.path}`);
});
