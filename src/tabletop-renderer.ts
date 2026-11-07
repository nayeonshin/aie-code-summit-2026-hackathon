import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Scenario } from './tabletop-scenarios';
import type { TableEpisode, TableFrame } from './tabletop-physics';

export class TabletopRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, .01, 20);
  private controls: OrbitControls;
  private objects: THREE.Mesh[] = [];
  private stage = new THREE.Group();
  private props = new THREE.Group();
  private matrix = new THREE.Matrix4();
  private resize: ResizeObserver;
  private animation = 0;
  constructor(private canvas: HTMLCanvasElement, private shared?: { renderer: THREE.WebGLRenderer; viewport: HTMLElement }) {
    this.renderer = shared?.renderer ?? new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    if (!shared) this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;
    this.renderer.shadowMap.enabled = !shared;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#aca895', 3));
    const key = new THREE.DirectionalLight('#fff7e5', 3);
    key.position.set(-1, -1, 3); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -1; key.shadow.camera.right = 1; key.shadow.camera.top = 1; key.shadow.camera.bottom = -1; key.shadow.camera.near = .1; key.shadow.camera.far = 5; key.shadow.bias = -.0003;
    this.scene.add(key, this.stage, this.props);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#eeede6', roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    // MuJoCo is Z-up. Keep all geometry/cameras in that coordinate system.
    floor.rotation.set(0, 0, 0); floor.position.z = .08; floor.receiveShadow = true; this.scene.add(floor);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, shared?.viewport ?? canvas);
    this.controls.enableDamping = true; this.controls.minDistance = .5; this.controls.maxDistance = 2.6;
    this.controls.maxPolarAngle = Math.PI / 2 - .06; this.controls.target.set(0, 0, .77);
    this.resetCamera();
    this.resize = new ResizeObserver(() => this.fit()); this.resize.observe(shared?.viewport ?? canvas); this.fit();
    if (!shared) this.draw();
  }
  resetCamera = () => { this.camera.position.set(.95, -1.25, 1.65); this.controls.target.set(0, 0, .77); this.controls.update(); };
  private fit() { const rect = (this.shared?.viewport ?? this.canvas).getBoundingClientRect(); if (!this.shared) this.renderer.setSize(rect.width, rect.height, false); this.camera.aspect = rect.width / Math.max(1, rect.height); this.camera.updateProjectionMatrix(); }
  private clear(group: THREE.Group) { group.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach(m => m.dispose()); } }); group.clear(); }
  load(episode: TableEpisode) {
    this.clear(this.stage); this.clear(this.props);
    this.objects = episode.geoms.map(g => {
      let geometry: THREE.BufferGeometry;
      if (g.mesh) { geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(g.mesh.vertices, 3)); geometry.setIndex(g.mesh.faces); geometry.computeVertexNormals(); }
      else if (g.type === 'box') geometry = new THREE.BoxGeometry(g.size[0] * 2, g.size[1] * 2, g.size[2] * 2);
      else if (g.type === 'sphere') geometry = new THREE.SphereGeometry(g.size[0], 16, 12);
      else { geometry = new THREE.CylinderGeometry(g.size[0], g.size[0], g.size[1] * 2, 32); geometry.rotateX(Math.PI / 2); }
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: g.color, roughness: g.type === 'sphere' ? .3 : .65, metalness: g.mesh ? .22 : .02 }));
      mesh.castShadow = true; mesh.receiveShadow = true; this.stage.add(mesh); return mesh;
    });
    this.decorate(episode.scenario); this.frame(episode.frames[0]);
  }
  private decorate(s: Scenario) {
    for (const [x, y] of [[-.4, -.25], [.4, -.25], [-.4, .25], [.4, .25]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(.025, .025, .6), new THREE.MeshStandardMaterial({ color: '#8b8c7f' }));
      leg.position.set(x, y, .385); this.props.add(leg);
    }
    if (s.task !== 'pour') {
      const ring = new THREE.Mesh(new THREE.RingGeometry(.049, .051, 64), new THREE.MeshBasicMaterial({ color: '#799374', side: THREE.DoubleSide }));
      ring.position.set(...s.goal, s.task === 'stack' ? .785 : .721); this.props.add(ring);
    }
    const grid = new THREE.GridHelper(.9, 18, '#b0ab9f', '#bdb8ad');
    grid.rotation.x = Math.PI / 2; grid.position.z = .721;
    (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = .18; this.props.add(grid);
  }
  frame(frame: TableFrame) {
    this.objects.forEach((object, i) => { const p = frame.positions[i], r = frame.rotations[i]; this.matrix.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1); object.position.set(p[0], p[1], p[2]); object.quaternion.setFromRotationMatrix(this.matrix); });
  }
  private draw = () => { if (!document.hidden && this.canvas.clientWidth > 0) { this.controls.update(); this.renderer.render(this.scene, this.camera); } this.animation = requestAnimationFrame(this.draw); };
  render() {
    if (this.shared) {
      const rect = this.shared.viewport.getBoundingClientRect(), parent = this.canvas.getBoundingClientRect();
      this.renderer.setViewport(rect.left - parent.left, parent.bottom - rect.bottom, rect.width, rect.height);
      this.renderer.setScissor(rect.left - parent.left, parent.bottom - rect.bottom, rect.width, rect.height);
    }
    this.controls.update(); this.renderer.render(this.scene, this.camera);
  }
  dispose() { cancelAnimationFrame(this.animation); this.resize.disconnect(); this.controls.dispose(); this.clear(this.stage); this.clear(this.props); this.scene.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } else if (o instanceof THREE.Light && 'shadow' in o) (o as THREE.DirectionalLight).shadow.dispose(); }); if (!this.shared) this.renderer.dispose(); }
}
