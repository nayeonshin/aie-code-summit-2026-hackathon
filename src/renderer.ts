import * as THREE from 'three';

export type State = { time: number; positions: number[][]; rotations: number[][]; qpos: number[]; qvel: number[]; ctrl: number[]; contacts: number };
export type Description = { meshes: { vertices: number[]; faces: number[] }[]; geoms: { id: number; mesh: number; name: string; tip: boolean }[]; recipes: string[] };
type View = { scene: THREE.Scene; camera: THREE.PerspectiveCamera; hand: THREE.Group; parts: { id: number; mesh: THREE.Mesh }[]; ready: boolean };

export class HandRenderer {
  renderer: THREE.WebGLRenderer;
  views: View[] = [];
  elements: HTMLElement[] = [];
  states: State[] = [];
  disposed = false;
  private animation = 0;
  private matrix = new THREE.Matrix4();
  private quaternion = new THREE.Quaternion();
  private geometries: THREE.BufferGeometry[];
  private dark = new THREE.MeshStandardMaterial({ color: '#515854', roughness: .42, metalness: .32 });
  private light = new THREE.MeshStandardMaterial({ color: '#d1d6c9', roughness: .68, metalness: .08 });

  constructor(canvas: HTMLCanvasElement, description: Description) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor('#f5f5f2', 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.5;
    this.geometries = description.meshes.map(mesh => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices, 3));
      geometry.setIndex(mesh.faces);
      geometry.computeVertexNormals();
      return geometry;
    });
    for (let i = 0; i < 16; i++) {
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight('#ffffff', '#92988b', 2.8));
      const key = new THREE.DirectionalLight('#fffaf0', 3.3);
      key.position.set(.4, -.3, .7); scene.add(key);
      const rim = new THREE.DirectionalLight('#dde4ed', 2);
      rim.position.set(-.3, .4, .2); scene.add(rim);
      const hand = new THREE.Group(); scene.add(hand);
      const parts = description.geoms.map(geom => {
        const mesh = new THREE.Mesh(this.geometries[geom.mesh], geom.tip ? this.light : this.dark);
        hand.add(mesh); return { id: geom.id, mesh };
      });
      const camera = new THREE.PerspectiveCamera(32, 1, .001, 10);
      this.views.push({ scene, camera, hand, parts, ready: false });
    }
    this.draw();
  }

  draw = () => {
    if (this.disposed) return;
    const width = window.innerWidth, height = window.innerHeight;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height) this.renderer.setSize(width, height, false);
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.setScissorTest(true);
    this.elements.forEach((element, i) => {
      const state = this.states[i];
      if (!element || !state) return;
      const rect = element.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > height) return;
      const view = this.views[i];
      view.parts.forEach(({ id, mesh }) => {
        const p = state.positions[id], r = state.rotations[id];
        if (!p || !r) return;
        this.matrix.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
        this.quaternion.setFromRotationMatrix(this.matrix);
        if (!view.ready) { mesh.position.set(...p as [number, number, number]); mesh.quaternion.copy(this.quaternion); }
        else { mesh.position.lerp(new THREE.Vector3(...p as [number, number, number]), .45); mesh.quaternion.slerp(this.quaternion, .45); }
      });
      if (!view.ready) {
        const box = new THREE.Box3().setFromObject(view.hand);
        const center = box.getCenter(new THREE.Vector3());
        const extent = box.getSize(new THREE.Vector3()).length();
        // Fixed framing after the first physical state; no camera pumping as fingers move.
        view.camera.position.copy(center).add(new THREE.Vector3(-.25, -.55, 1.5).normalize().multiplyScalar(extent * 2.15));
        // The LEAP fingers extend along world +X; frame them upright, not sideways.
        view.camera.up.set(1, 0, 0);
        view.camera.lookAt(center);
        view.ready = true;
      }
      view.camera.aspect = rect.width / rect.height;
      view.camera.zoom = Math.min(1, view.camera.aspect / .8);
      view.camera.updateProjectionMatrix();
      this.renderer.setViewport(rect.left, height - rect.bottom, rect.width, rect.height);
      this.renderer.setScissor(rect.left, height - rect.bottom, rect.width, rect.height);
      this.renderer.render(view.scene, view.camera);
    });
    this.animation = requestAnimationFrame(this.draw);
  };

  capture(index: number) {
    const element = this.elements[index];
    if (!element || !this.states[index]) throw new Error('No live frame available.');
    const rect = element.getBoundingClientRect();
    const source = this.renderer.domElement;
    const scale = source.width / window.innerWidth;
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = Math.round(384 * rect.height / rect.width);
    const context = canvas.getContext('2d')!;
    context.drawImage(source, rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale, 0, 0, canvas.width, canvas.height);
    const state = this.states[index];
    return { image: canvas.toDataURL('image/png').split(',')[1], telemetry: { time: state.time, qpos: [...state.qpos], contacts: state.contacts } };
  }

  dispose() {
    this.disposed = true; cancelAnimationFrame(this.animation);
    this.geometries.forEach(g => g.dispose()); this.dark.dispose(); this.light.dispose(); this.renderer.dispose();
  }
}
