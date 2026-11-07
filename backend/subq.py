"""VLM annotations are advisory and never replace physics validation."""
import asyncio
import base64
import hashlib
import json
import os
import httpx
from backend.simulation import ROOT
from backend.objectives import OBJECTIVES

class SubQError(Exception): pass

class SubQ:
    def __init__(self):
        self.semaphore = asyncio.Semaphore(2)
        self.cache = ROOT / 'data/annotations'
        self.cache.mkdir(parents=True, exist_ok=True)

    async def annotate(self, frames, summary):
        key = os.getenv('SUBQ_API_KEY', '')
        if not key: raise SubQError('SubQ key is not configured.')
        if not 1 <= len(frames) <= 4: raise SubQError('Provide 1–4 sampled frames.')
        decoded = []
        for frame in frames:
            try: raw = base64.b64decode(frame, validate=True)
            except Exception: raise SubQError('Invalid image encoding.')
            if not raw.startswith(b'\x89PNG\r\n\x1a\n') or len(raw) > 4 * 1024 * 1024:
                raise SubQError('Expected a PNG image smaller than 4 MiB.')
            decoded.append(raw)
        if sum(map(len, decoded)) > 8 * 1024 * 1024: raise SubQError('Images exceed 8 MiB.')
        model = os.getenv('SUBQ_MODEL', 'subq-snap-1.1')
        choices = {**{o['id']: o['goal'] for o in OBJECTIVES}, **{
            'flex': 'All fingers curl and extend together',
            'point': 'Index extends while the other fingers curl',
            'pinch': 'Index and thumb curl toward a pinch-shaped pose',
            'wave': 'Fingers flex with a traveling phase offset',
            'tripod': 'Index, middle and thumb form a three-finger pinch-shaped pose',
            'spread': 'Fingers move sideways apart while remaining mostly extended',
            'sequence': 'Individual fingers curl in succession',
            'opposition': 'Thumb moves toward the fingers while fingers mostly stay extended',
            'roll': 'Fingers perform small phase-offset cyclic curls',
            'unclear': 'Insufficient visual evidence to classify reliably',
        }}
        payload = {'model': model, 'state': {'instructions': 'Frames are chronological samples of a simulated LEAP robotic hand. Infer the visible movement; do not assume physical safety from images.', 'telemetry': summary},
                   'images': [{'mediaType': 'image/png', 'base64': f} for f in frames],
                   'questions': {'movement': {'type': 'choice', 'instructions': 'Which movement best matches the sampled frames and telemetry?',
                                              'criteria': choices},
                                 'coordination': {'type': 'score', 'instructions': 'Rate visible finger coordination, not physical safety.',
                                                  'criteria': ['Cannot assess or incoherent', 'Partly coordinated', 'Clearly coordinated']}}}
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        path = self.cache / (digest + '.json')
        async with self.semaphore:
            if path.exists(): return {**json.loads(path.read_text()), 'cached': True}
            async with httpx.AsyncClient(timeout=45) as client:
                for attempt in range(3):
                    try:
                        response = await client.post(os.getenv('SUBQ_BASE_URL', 'https://api.subq.ai').rstrip('/') + '/v1/systemone',
                                                     headers={'Authorization': f'Bearer {key}'}, json=payload)
                    except httpx.RequestError:
                        if attempt < 2: await asyncio.sleep(2 ** attempt); continue
                        raise SubQError('SubQ could not be reached.')
                    if response.status_code in [429, 500, 502, 503, 504] and attempt < 2:
                        await asyncio.sleep(2 ** attempt); continue
                    if response.status_code != 200:
                        # Never send provider response bodies (which could contain secrets) to the browser.
                        raise SubQError(f'SubQ returned HTTP {response.status_code}. Check account access and credits.')
                    body = response.json()
                    if 'answers' not in body: raise SubQError('SubQ response did not contain decisions.')
                    result = {'model': model, 'answers': body['answers'], 'usage': body.get('usage'),
                              'input_sha256': digest, 'image_count': len(frames), 'advisory': True}
                    path.write_text(json.dumps(result))
                    return result
        raise SubQError('SubQ request failed.')
