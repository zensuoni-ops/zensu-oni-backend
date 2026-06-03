import express from 'express';
import cors from 'cors';
import { parseStringPromise } from 'xml2js';
import WebTorrent from 'webtorrent';

const app = express();
const client = new WebTorrent();

app.use(cors());
app.use(express.json());

app.get('/search', async (req, res) => {
  const { anime, episode } = req.query;
  if (!anime || !episode) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  try {
    const epNum = String(episode).padStart(2, '0');
    const queries = [
      `SubsPlease ${anime} ${epNum}`,
      `${anime} ${epNum} 1080p`,
      `${anime} ${epNum}`
    ];
    for (const query of queries) {
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
          streamUrl: `/stream?magnet=${encodeURIComponent(magnet)}`
        });
      }
    }
    res.status(404).json({ error: 'Episode not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/stream', (req, res) => {
  const { magnet } = req.query;
  if (!magnet) return res.status(400).json({ error: 'Missing magnet' });

  const existing = client.torrents.find(t => t.magnetURI === decodeURIComponent(magnet));
  if (existing) {
    const file = existing.files.find(f => f.name.match(/\.(mkv|mp4|avi)$/));
    if (file) return streamFile(file, req, res);
  }

  client.add(decodeURIComponent(magnet), (torrent) => {
    const file = torrent.files.find(f => f.name.match(/\.(mkv|mp4|avi)$/));
    if (!file) return res.status(404).json({ error: 'No video found' });
    streamFile(file, req, res);
  });
});

function streamFile(file, req, res) {
  const fileSize = file.length;
  const range = req.headers.range;
  if (range) {
    const [start, end] = range.replace(/bytes=/, '').split('-').map(Number);
    const chunkEnd = end || fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${chunkEnd}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkEnd - start + 1,
      'Content-Type': 'video/mp4',
    });
    file.createReadStream({ start, end: chunkEnd }).pipe(res);
  } else {
    res.writeHead(200, { 
      'Content-Length': fileSize, 
      'Content-Type': 'video/mp4' 
    });
    file.createReadStream().pipe(res);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zensu-Oni backend running on port ${PORT}`));
