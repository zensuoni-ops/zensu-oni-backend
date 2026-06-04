import express from 'express';
import cors from 'cors';
import { parseStringPromise } from 'xml2js';
import WebTorrent from 'webtorrent';

const app = express();
const client = new WebTorrent();

app.use(cors());
app.use(express.json());

// Keep-alive endpoint for cron-job
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Extract season number from title like "4th Season" or "Season 2"
function extractSeasonNumber(title) {
  const match = title.match(/(\d+)(?:st|nd|rd|th)\s+season/i)
    || title.match(/season\s*(\d+)/i);
  return match ? parseInt(match[1]) : 1;
}

// Strip everything after the season info
function cleanBaseTitle(title) {
  return title
    .replace(/\d+(st|nd|rd|th)\s+season.*/i, '')
    .replace(/season\s*\d+.*/i, '')
    .replace(/part\s*\d+.*/i, '')
    .replace(/cour\s*\d+.*/i, '')
    .replace(/\s*:\s*.*$/, '')
    .trim();
}

// Ask AniList for the real official title
async function resolveAnimeTitle(animeName) {
  const query = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        title {
          romaji
          english
          native
        }
        synonyms
      }
    }
  `;
  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        query, 
        variables: { search: animeName } 
      })
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

// Main search endpoint
app.get('/search', async (req, res) => {
  const { anime, episode, type } = req.query;
  
  if (!anime || !episode) {
    return res.status(400).json({ error: 'Missing anime or episode parameter' });
  }

  try {
    const epNum = parseInt(episode);
    const seasonNum = extractSeasonNumber(anime);
    const isDub = (type || 'sub').toLowerCase() === 'dub';

    // S##E## format - universal Nyaa.si standard
    const sxeFormat = `S${String(seasonNum).padStart(2,'0')}E${String(epNum).padStart(2,'0')}`;
    const epPadded = String(epNum).padStart(2, '0');

    // Get official titles from AniList
    const titles = await resolveAnimeTitle(anime);

    // Clean all titles
    const englishClean = titles.english ? cleanBaseTitle(titles.english) : null;
    const romajiClean = titles.romaji ? cleanBaseTitle(titles.romaji) : null;
    const originalClean = cleanBaseTitle(anime);

    // Build search queries
    const queries = [];

    if (isDub) {
      // DUB searches
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
      // SUB searches (default)
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
      // Try synonyms (handles cases like Oshi no Ko)
      for (const syn of titles.synonyms.slice(0, 3)) {
        const synClean = cleanBaseTitle(syn);
        queries.push(`SubsPlease ${synClean} ${epPadded}`);
        queries.push(`${synClean} ${sxeFormat}`);
      }
      // Always add fallbacks
      queries.push(`SubsPlease ${originalClean} ${epPadded}`);
      queries.push(`${originalClean} ${sxeFormat}`);
      queries.push(`${originalClean} ${epPadded}`);
    }

    // Try each query against Nyaa.si
    for (const query of queries) {
      try {
        const nyaaUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=1_2&f=0`;
        const response = await fetch(nyaaUrl);
        const xml = await response.text();
        const result = await parseStringPromise(xml);
        const items = result?.rss?.channel?.[0]?.item;

        if (items && items.length > 0) {
          const best = items[0];
          const magnet = best['nyaa:magnetLink']?.[0] || best.link?.[0];
          return res.json({
            title: best.title[0],
            magnet: magnet,
            matchedQuery: query,
            resolvedTitle: englishClean || romajiClean || originalClean,
            streamUrl: `/stream?magnet=${encodeURIComponent(magnet)}`
          });
        }
      } catch {
        continue;
      }
    }

    // Nothing found
    res.status(404).json({
      error: 'Episode not found on Nyaa.si',
      resolvedAs: {
        english: englishClean,
        romaji: romajiClean
      },
      triedQueries: queries.slice(0, 5)
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stream endpoint
app.get('/stream', (req, res) => {
  const { magnet } = req.query;
  if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

  const decoded = decodeURIComponent(magnet);

  const existing = client.torrents.find(t => t.magnetURI === decoded);
  if (existing) {
    const file = existing.files.find(f => f.name.match(/\.(mkv|mp4|avi)$/i));
    if (file) return streamFile(file, req, res);
  }

  client.add(decoded, (torrent) => {
    const file = torrent.files
      .sort((a, b) => b.length - a.length)
      .find(f => f.name.match(/\.(mkv|mp4|avi)$/i));
    
    if (!file) return res.status(404).json({ error: 'No video file found in torrent' });
    streamFile(file, req, res);
  });
});

function streamFile(file, req, res) {
  const fileSize = file.length;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0]);
    const end = parts[1] ? parseInt(parts[1]) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    file.createReadStream({ start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes'
    });
    file.createReadStream().pipe(res);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zensu-Oni backend running on port ${PORT}`));
