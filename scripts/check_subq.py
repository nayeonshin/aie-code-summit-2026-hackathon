"""Optional real text+image smoke check. No API call unless --send is provided."""
import argparse
import asyncio
import base64
import json
import struct
import zlib
import mujoco
import numpy as np
from dotenv import load_dotenv
from backend.simulation import ROOT, Simulation, load_model
from backend.subq import SubQ

def png(image):
    height, width, _ = image.shape
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    scanlines = b''.join(b'\0' + row.tobytes() for row in image.astype(np.uint8))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(scanlines)) + chunk(b'IEND', b'')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--send', action='store_true', help='Send four rendered frames + telemetry to SubQ (uses API credits)')
    args = parser.parse_args()
    load_dotenv(ROOT / '.env')
    model = load_model()
    for i in range(model.ngeom):
        model.geom_group[i] = 1 if model.geom_type[i] == mujoco.mjtGeom.mjGEOM_MESH else 3
    sim = Simulation(model, 'flex', 42)
    camera = mujoco.MjvCamera()
    camera.lookat[:] = [.03, .02, .12]
    camera.distance = .45
    camera.azimuth = 130
    camera.elevation = -30
    option = mujoco.MjvOption()
    option.geomgroup[3] = 0
    out = ROOT / 'data/probe'
    out.mkdir(parents=True, exist_ok=True)
    frames, telemetry = [], []
    with mujoco.Renderer(model, height=384, width=384) as renderer:
        for index in range(4):
            for _ in range(20): sim.advance()
            renderer.update_scene(sim.data, camera=camera, scene_option=option)
            raw = png(renderer.render())
            (out / f'{index}.png').write_bytes(raw)
            frames.append(base64.b64encode(raw).decode())
            telemetry.append({'time': sim.data.time, 'qpos': sim.data.qpos.tolist(), 'contacts': int(sim.data.ncon)})
    print('Rendered four hand frames in data/probe/')
    if args.send:
        print(json.dumps(asyncio.run(SubQ().annotate(frames, {'samples': telemetry})), indent=2))

if __name__ == '__main__': main()
