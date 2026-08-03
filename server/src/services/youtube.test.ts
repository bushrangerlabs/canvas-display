import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildYouTubeEmbedUrl,
  buildYouTubePlayerHtml,
  buildYouTubeWatchUrl,
  extractYouTubeVideoId,
  extractYouTubePlaylistId,
  normalizeYouTubeQuery,
  rankYouTubeCandidates,
  rankYouTubePlaylistCandidates,
  resolveYouTubeCandidates,
  resolveYouTubeVideoId,
  scoreYouTubeCandidate,
  YouTubeApiError,
  type YouTubeCandidate,
  type YouTubePlaylistCandidate,
} from './youtube';

test('extracts IDs from canonical and recoverable YouTube URLs', () => {
  const id = '3_TvpBwSZDM';
  assert.equal(extractYouTubeVideoId(id), id);
  assert.equal(extractYouTubeVideoId(`https://www.youtube.com/watch?v=${id}`), id);
  assert.equal(extractYouTubeVideoId(`https://youtu.be/${id}?si=test`), id);
  assert.equal(extractYouTubeVideoId(`https://www.youtube.com/embed/${id}?autoplay=1`), id);
  assert.equal(extractYouTubeVideoId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(extractYouTubeVideoId(`https://www.youtube.com/watch/${id}`), id);
});

test('rejects invalid YouTube IDs and unrelated URLs', () => {
  assert.equal(extractYouTubeVideoId('too-short'), null);
  assert.equal(extractYouTubeVideoId('Radioactive'), null);
  assert.equal(extractYouTubeVideoId('https://example.com/watch?v=3_TvpBwSZDM'), null);
  assert.equal(extractYouTubeVideoId('https://www.youtube.com/results?search_query=test'), null);
});

test('extracts public YouTube playlist IDs', () => {
  assert.equal(extractYouTubePlaylistId('https://www.youtube.com/playlist?list=PL1234567890abcdef'), 'PL1234567890abcdef');
  assert.equal(extractYouTubePlaylistId('https://www.youtube.com/watch?v=3_TvpBwSZDM&list=PL1234567890abcdef'), 'PL1234567890abcdef');
  assert.equal(extractYouTubePlaylistId('https://example.com/?list=PL1234567890abcdef'), null);
});

test('unwraps nested and malformed YouTube search URLs into a clean query', () => {
  const nested = 'https://www.youtube.com/results?search_query=https%3A%2F%2Fwww..com%2Fresults%3Fsearch_query%3DI%2BShould%2BBe%2BSo%2BLucky';
  assert.equal(normalizeYouTubeQuery(nested), 'I Should Be So Lucky');
  assert.equal(normalizeYouTubeQuery('Play I Should Be So Lucky on YouTube'), 'I Should Be So Lucky');
  assert.equal(normalizeYouTubeQuery('Radioactive'), 'Radioactive');
  assert.equal(normalizeYouTubeQuery('site:youtube.com/watch Kylie Minogue official video'), 'Kylie Minogue official video');
});

test('builds a local IFrame API player with runtime candidate failover', () => {
  const html = buildYouTubePlayerHtml(['3_TvpBwSZDM', 'vTSRa6QFk8Q'], 'playback-1');
  assert.match(html, /youtube\.com\/iframe_api/);
  assert.match(html, /origin: window\.location\.origin/);
  assert.match(html, /strict-origin-when-cross-origin/);
  assert.match(html, /const candidates = \["3_TvpBwSZDM","vTSRa6QFk8Q"\]/);
  assert.match(html, /\[2, 5, 100, 101, 150\]\.includes\(code\)/);
  assert.match(html, /code === 153/);
  assert.match(html, /fatalPlayerError = true/);
  assert.match(html, /window\.clearTimeout\(switchTimer\)/);
  assert.match(html, /player\.loadVideoById/);
  assert.match(html, /\/api\/media\/youtube\/player-event/);
  assert.match(html, /__canvasYouTubeControl/);
  assert.match(html, /pauseVideo/);
  assert.match(html, /nextCandidate/);
  assert.match(html, /canvas-close/);
  assert.match(html, /#canvas-controls[\s\S]*right:\s*112px/);
  assert.match(html, /canvas-player:\/\/close/);
  assert.match(html, /touch_close/);
  assert.match(html, /fs: 0/);
});

test('playlist player automatically advances when a track ends', () => {
  const html = buildYouTubePlayerHtml(['3_TvpBwSZDM', 'vTSRa6QFk8Q'], 'playlist-1', true);
  assert.match(html, /const playlistMode = true/);
  assert.match(html, /PlayerState\.ENDED[\s\S]*if \(playlistMode\) nextCandidate\(\)/);
});

test('ranks closely matching substantial playlists above loose first results', () => {
  const playlists: YouTubePlaylistCandidate[] = [
    { playlistId: 'PLloose0000001', title: 'Music I Like', channelTitle: 'Random User', description: 'Various songs', itemCount: 9, searchPosition: 0 },
    { playlistId: 'PLmatch0000002', title: 'Best 80s Music Playlist', channelTitle: 'Official Music', description: 'Eighties pop and rock hits', itemCount: 84, searchPosition: 4 },
    { playlistId: 'PLbad00000003', title: '80s Karaoke Covers', channelTitle: 'Karaoke Fan', description: 'Cover versions', itemCount: 120, searchPosition: 1 },
  ];
  const ranked = rankYouTubePlaylistCandidates(playlists, 'an eighties music playlist');
  assert.equal(ranked[0].playlistId, 'PLmatch0000002');
});

test('ranks a relevant single-song result ahead of mashups and unrelated videos', () => {
  const candidates: YouTubeCandidate[] = [
    {
      videoId: 'OiZlXOAOLLw',
      title: 'Kylie Minogue & Rick Astley - I Should Be So Lucky / Never Gonna Give You Up (Hyde Park 2018)',
      channelTitle: 'BBC Music',
      thumbnailUrl: '',
      madeForKids: false,
      searchPosition: 0,
    },
    {
      videoId: 'vTSRa6QFk8Q',
      title: 'Kylie Minogue & Jools Holland - I Should Be So Lucky (Hootenanny Archive 2007)',
      channelTitle: 'BBC Music',
      thumbnailUrl: '',
      madeForKids: false,
      searchPosition: 1,
    },
    {
      videoId: 'POWsFzSFLCE',
      title: 'Kylie Minogue - The Loco-motion - Official Video',
      channelTitle: 'PWL',
      thumbnailUrl: '',
      madeForKids: false,
      searchPosition: 2,
    },
  ];

  const ranked = rankYouTubeCandidates(candidates, 'I Should Be So Lucky');
  assert.equal(ranked[0].videoId, 'vTSRa6QFk8Q');
  assert.equal(ranked.at(-1)?.videoId, 'POWsFzSFLCE');
  assert(scoreYouTubeCandidate(ranked[0], 'I Should Be So Lucky') > scoreYouTubeCandidate(ranked[1], 'I Should Be So Lucky'));
});

test('uses the supported Data API filters and validates candidate status and region', async () => {
  const requestedUrls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url);

    if (url.pathname.endsWith('/search')) {
      return new Response(JSON.stringify({
        regionCode: 'AU',
        items: [
          {
            id: { videoId: '3_TvpBwSZDM' },
            snippet: { title: 'Kylie Minogue - I Should Be So Lucky - Official Video', channelTitle: 'PWL' },
          },
          {
            id: { videoId: 'OiZlXOAOLLw' },
            snippet: { title: 'Kylie Minogue & Rick Astley - I Should Be So Lucky / Never Gonna Give You Up', channelTitle: 'BBC Music' },
          },
          {
            id: { videoId: 'vTSRa6QFk8Q' },
            snippet: { title: 'Kylie Minogue & Jools Holland - I Should Be So Lucky (Hootenanny Archive 2007)', channelTitle: 'BBC Music' },
          },
          {
            id: { videoId: 'POWsFzSFLCE' },
            snippet: { title: 'Kylie Minogue - The Loco-motion - Official Video', channelTitle: 'PWL' },
          },
          {
            id: { videoId: 'LTkC4BQ5XTI' },
            snippet: { title: 'I SHOULD BE SO LUCKY | The Story', channelTitle: 'AMTV NOW' },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname.endsWith('/videos')) {
      return new Response(JSON.stringify({
        items: [
          {
            id: '3_TvpBwSZDM',
            snippet: { title: 'Kylie Minogue - I Should Be So Lucky - Official Video', channelTitle: 'PWL' },
            status: { embeddable: false, privacyStatus: 'public', uploadStatus: 'processed', madeForKids: false },
            contentDetails: {},
          },
          {
            id: 'OiZlXOAOLLw',
            snippet: { title: 'Kylie Minogue & Rick Astley - I Should Be So Lucky / Never Gonna Give You Up', channelTitle: 'BBC Music' },
            status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed', madeForKids: false },
            contentDetails: {},
          },
          {
            id: 'vTSRa6QFk8Q',
            snippet: { title: 'Kylie Minogue & Jools Holland - I Should Be So Lucky (Hootenanny Archive 2007)', channelTitle: 'BBC Music' },
            status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed', madeForKids: false },
            contentDetails: {},
          },
          {
            id: 'POWsFzSFLCE',
            snippet: { title: 'Kylie Minogue - The Loco-motion - Official Video', channelTitle: 'PWL' },
            status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed', madeForKids: false },
            contentDetails: { regionRestriction: { blocked: ['AU'] } },
          },
          {
            id: 'LTkC4BQ5XTI',
            snippet: { title: 'I SHOULD BE SO LUCKY | The Story', channelTitle: 'AMTV NOW' },
            status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed', madeForKids: false },
            contentDetails: { contentRating: { ytRating: 'ytAgeRestricted' } },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('{}', { status: 404 });
  };

  const candidates = await resolveYouTubeCandidates('Play I Should Be So Lucky on YouTube', '', {
    apiKey: 'test-api-key',
    regionCode: 'AU',
    relevanceLanguage: 'en-AU',
    safeSearch: 'strict',
    maxResults: 25,
    fetchImpl,
  });

  assert.deepEqual(candidates.map((candidate) => candidate.videoId), ['vTSRa6QFk8Q', 'OiZlXOAOLLw']);

  const searchRequest = requestedUrls.find((url) => url.pathname.endsWith('/search'));
  assert(searchRequest);
  assert.equal(searchRequest.searchParams.get('type'), 'video');
  assert.equal(searchRequest.searchParams.get('videoEmbeddable'), 'true');
  assert.equal(searchRequest.searchParams.get('videoSyndicated'), 'true');
  assert.equal(searchRequest.searchParams.get('regionCode'), 'AU');
  assert.equal(searchRequest.searchParams.get('relevanceLanguage'), 'en-AU');
  assert.equal(searchRequest.searchParams.get('safeSearch'), 'strict');
});

test('keeps an eligible explicit URL ahead of ranked title-search fallbacks', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/search')) {
      return new Response(JSON.stringify({
        items: [{
          id: { videoId: 'vTSRa6QFk8Q' },
          snippet: { title: 'Kylie Minogue - I Should Be So Lucky', channelTitle: 'Search result' },
        }],
      }), { status: 200 });
    }
    if (url.pathname.endsWith('/videos')) {
      return new Response(JSON.stringify({
        items: [
          {
            id: 'OiZlXOAOLLw',
            snippet: { title: 'Kylie Minogue & Rick Astley - I Should Be So Lucky / Never Gonna Give You Up' },
            status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed' },
            contentDetails: {},
          },
          {
            id: 'vTSRa6QFk8Q',
            snippet: { title: 'Kylie Minogue - I Should Be So Lucky' },
            status: { embeddable: true, privacyStatus: 'public', uploadStatus: 'processed' },
            contentDetails: {},
          },
        ],
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const candidates = await resolveYouTubeCandidates(
    'https://www.youtube.com/watch?v=OiZlXOAOLLw',
    'I Should Be So Lucky',
    { apiKey: 'test-api-key', fetchImpl },
  );
  assert.deepEqual(candidates.map((candidate) => candidate.videoId), ['OiZlXOAOLLw', 'vTSRa6QFk8Q']);
});

test('does not resurrect a direct video rejected by status validation', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/videos')) {
      return new Response(JSON.stringify({
        items: [{
          id: '3_TvpBwSZDM',
          snippet: { title: 'Blocked official video' },
          status: { embeddable: false, privacyStatus: 'public', uploadStatus: 'processed' },
          contentDetails: {},
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  assert.deepEqual(
    await resolveYouTubeCandidates('https://www.youtube.com/watch?v=3_TvpBwSZDM', '', {
      apiKey: 'test-api-key',
      fetchImpl,
    }),
    [],
  );
});

test('rejects incomplete privacy and upload status metadata', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/videos')) {
      return new Response(JSON.stringify({
        items: [{
          id: 'abc123DEF45',
          snippet: { title: 'Incomplete status' },
          status: { embeddable: true },
          contentDetails: {},
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  assert.deepEqual(
    await resolveYouTubeCandidates('https://www.youtube.com/watch?v=abc123DEF45', '', {
      apiKey: 'test-api-key',
      fetchImpl,
    }),
    [],
  );
});

test('validates eligible search results beyond the player fallback pool size', async () => {
  const ids = Array.from({ length: 12 }, (_value, index) => `video${String(index + 1).padStart(6, '0')}`);
  let validatedIdCount = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/search')) {
      return new Response(JSON.stringify({
        items: ids.map((videoId, index) => ({
          id: { videoId },
          snippet: { title: index === 11 ? 'Exact Requested Song' : `Unrelated result ${index + 1}` },
        })),
      }), { status: 200 });
    }

    if (url.pathname.endsWith('/videos')) {
      const requestedIds = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      validatedIdCount = requestedIds.length;
      return new Response(JSON.stringify({
        items: requestedIds.map((videoId) => ({
          id: videoId,
          snippet: { title: videoId === ids[11] ? 'Exact Requested Song' : 'Unrelated result' },
          status: {
            embeddable: videoId === ids[11],
            privacyStatus: 'public',
            uploadStatus: 'processed',
          },
          contentDetails: {},
        })),
      }), { status: 200 });
    }

    return new Response('{}', { status: 404 });
  };

  const candidates = await resolveYouTubeCandidates('Exact Requested Song', '', {
    apiKey: 'test-api-key',
    fetchImpl,
    maxResults: 25,
  });

  assert.equal(validatedIdCount, 12);
  assert.deepEqual(candidates.map((candidate) => candidate.videoId), [ids[11]]);
});

test('requires a Data API key for title search but not for a supplied video ID', async () => {
  await assert.rejects(
    resolveYouTubeCandidates('Radioactive'),
    (err: unknown) => err instanceof YouTubeApiError && err.code === 'youtube_api_key_missing' && err.httpStatus === 503,
  );

  assert.deepEqual(
    (await resolveYouTubeCandidates('https://www.youtube.com/watch/qK6IGnNeHn4')).map((candidate) => candidate.videoId),
    ['qK6IGnNeHn4'],
  );
});

test('uses the explicit local fallback for title search when no API key is configured', async () => {
  const calls: Array<{ query: string; maxResults: number }> = [];
  const candidates = await resolveYouTubeCandidates('Play Exact Requested Song on YouTube', '', {
    allowYtDlpFallback: true,
    fallbackSearch: async (query, maxResults) => {
      calls.push({ query, maxResults });
      return [
        {
          videoId: 'video000011',
          title: 'Unrelated documentary reaction',
          channelTitle: 'Other',
          thumbnailUrl: '',
          madeForKids: null,
          searchPosition: 0,
        },
        {
          videoId: 'video000012',
          title: 'Exact Requested Song',
          channelTitle: 'Artist',
          thumbnailUrl: '',
          madeForKids: null,
          searchPosition: 1,
        },
      ];
    },
  });
  assert.deepEqual(calls, [{ query: 'Exact Requested Song', maxResults: 25 }]);
  assert.equal(candidates[0]?.videoId, 'video000012');
});

test('builds canonical watch and embed URLs without deprecated player parameters', () => {
  assert.equal(
    buildYouTubeWatchUrl('3_TvpBwSZDM'),
    'https://www.youtube.com/watch?v=3_TvpBwSZDM&autoplay=1',
  );
  assert.equal(
    buildYouTubeEmbedUrl('3_TvpBwSZDM'),
    'https://www.youtube.com/embed/3_TvpBwSZDM?autoplay=1&enablejsapi=1&playsinline=1&rel=0',
  );
});

test('resolves recoverable watch paths without a Data API request', async () => {
  assert.equal(
    await resolveYouTubeVideoId('https://www.youtube.com/watch/qK6IGnNeHn4'),
    'qK6IGnNeHn4',
  );
});
