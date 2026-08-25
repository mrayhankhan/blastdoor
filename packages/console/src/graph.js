/**
 * The 3D dependency graph.
 *
 * This is not decoration. The blast radius IS a graph, and a list of affected services
 * throws away the one thing that explains *why* they are affected: the path the failure
 * takes. Rendering the topology and animating the failure travelling along its edges puts
 * the causal structure on screen, so the operator sees propagation order rather than an
 * alphabetised set of consequences.
 *
 * Layout is force-directed and settles in 3D. Severity is carried by colour AND by the
 * labelled list in the panel, never by colour alone.
 */
import * as THREE from 'three';

const SEVERITY = {
  unavailable: 0xd03b3b,
  degraded: 0xec835a,
  'elevated-latency': 0xfab219,
  'no-effect': 0x0ca30c,
};
const IDLE = 0x38414f;
const IDLE_EMISSIVE = 0x161a22;

/** How long the shockwave takes to cross one edge. */
const HOP_MS = 420;

export class BlastGraph {
  constructor(canvasParent, { onHover, onSelect } = {}) {
    this.onHover = onHover ?? (() => {});
    this.onSelect = onSelect ?? (() => {});

    this.nodes = new Map(); // id -> { mesh, halo, data, pos, vel, effect, hops }
    this.edges = [];
    this.impactByService = new Map();
    this.waveStart = 0;
    this.waveActive = false;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0a0c10, 0.028);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 400);
    this.camera.position.set(0, 4, 34);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    canvasParent.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(6, 10, 8);
    this.scene.add(key);
    const rim = new THREE.PointLight(0x3987e5, 0.6, 90);
    rim.position.set(-14, -6, 12);
    this.scene.add(rim);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-2, -2);
    this.hovered = null;

    // Orbit state. Hand-rolled rather than pulling in OrbitControls, because we only
    // need drag-to-rotate and wheel-to-zoom and this keeps the vendored surface to one file.
    this.spin = { theta: 0, phi: 0.18, radius: 34, autoSpin: true };
    this.dragging = false;
    this.#bindInput(canvasParent);

    this.resize();
    addEventListener('resize', () => this.resize());

    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  #bindInput(el) {
    const dom = this.renderer.domElement;
    let last = null;

    dom.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.spin.autoSpin = false;
      last = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
    });

    dom.addEventListener('pointerup', (e) => {
      this.dragging = false;
      last = null;
      dom.releasePointerCapture?.(e.pointerId);
      // A click without a drag selects whatever is under the cursor.
      if (this.hovered) this.onSelect(this.hovered);
    });

    dom.addEventListener('pointermove', (e) => {
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.cursor = { x: e.clientX, y: e.clientY };

      if (this.dragging && last) {
        this.spin.theta -= (e.clientX - last.x) * 0.005;
        this.spin.phi = Math.max(-1.2, Math.min(1.2, this.spin.phi - (e.clientY - last.y) * 0.005));
        last = { x: e.clientX, y: e.clientY };
      }
    });

    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.spin.radius = Math.max(16, Math.min(70, this.spin.radius + e.deltaY * 0.03));
      },
      { passive: false },
    );

    dom.addEventListener('pointerleave', () => {
      this.pointer.set(-2, -2);
      this.dragging = false;
    });
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Build the scene from a topology. Node radius encodes traffic, so the busy parts of
   * the estate are visibly the busy parts.
   */
  setTopology(services) {
    this.group.clear();
    this.nodes.clear();
    this.edges = [];

    const count = services.length;
    services.forEach((svc, i) => {
      // Seed positions on a sphere so the force layout starts untangled.
      const golden = Math.PI * (3 - Math.sqrt(5));
      const y = 1 - (i / Math.max(1, count - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      const pos = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).multiplyScalar(9);

      const radius = 0.5 + Math.min(1.1, Math.sqrt(svc.rps) / 32);
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(radius, 3),
        new THREE.MeshStandardMaterial({
          color: IDLE,
          emissive: IDLE_EMISSIVE,
          roughness: 0.42,
          metalness: 0.15,
        }),
      );
      mesh.position.copy(pos);
      mesh.userData.serviceId = svc.id;

      // A halo that scales up when the service is hit — cheap, and reads instantly.
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 1.6, 20, 20),
        new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, opacity: 0, side: THREE.BackSide }),
      );
      halo.position.copy(pos);

      this.group.add(mesh, halo);
      this.nodes.set(svc.id, {
        data: svc,
        mesh,
        halo,
        radius,
        pos,
        vel: new THREE.Vector3(),
        effect: null,
        hops: null,
        label: this.#makeLabel(svc.displayName, pos, radius),
      });
    });

    // Edges point caller -> callee, matching `dependsOn`.
    for (const svc of services) {
      for (const depId of svc.dependsOn) {
        if (!this.nodes.has(depId)) continue;
        const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        const line = new THREE.Line(
          geom,
          new THREE.LineBasicMaterial({ color: IDLE, transparent: true, opacity: 0.28 }),
        );
        this.group.add(line);
        this.edges.push({ from: svc.id, to: depId, line });
      }
    }

    // If a proposal already arrived while the topology was still in flight, colour the
    // nodes now that they exist and run the wave.
    if (this.pendingImpact) {
      this.#applyImpact();
      this.replay();
    }
  }

  #makeLabel(text, pos, radius) {
    const canvas = document.createElement('canvas');
    const scale = 3;
    const ctx = canvas.getContext('2d');
    ctx.font = `600 ${13 * scale}px ui-sans-serif, system-ui, sans-serif`;
    canvas.width = Math.ceil(ctx.measureText(text).width) + 16 * scale;
    canvas.height = 22 * scale;

    const c = canvas.getContext('2d');
    c.font = `600 ${13 * scale}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = '#e9eef6';
    c.textBaseline = 'middle';
    c.fillText(text, 8 * scale, canvas.height / 2);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, opacity: 0.75 }),
    );
    sprite.scale.set((canvas.width / canvas.height) * 1.5, 1.5, 1);
    sprite.position.copy(pos).add(new THREE.Vector3(0, radius + 1.1, 0));
    this.group.add(sprite);
    return sprite;
  }

  /**
   * Arm the graph with a blast-radius report and start the shockwave. Nodes light up in
   * hop order, so the animation reads as the failure travelling rather than everything
   * turning red at once.
   */
  setImpact(impacted) {
    // Held so it can be re-applied if the topology arrives afterwards. The topology fetch
    // and the proposal poll are independent requests, and when the poll wins the race
    // there are no nodes yet to colour — without this the graph draws the estate and then
    // never lights up, which is a silent failure of the one thing it exists to show.
    this.pendingImpact = impacted;
    this.impactByService = new Map(impacted.map((i) => [i.serviceId, i]));
    this.#applyImpact();
    this.replay();
  }

  #applyImpact() {
    for (const [id, node] of this.nodes) {
      const hit = this.impactByService.get(id);
      node.effect = hit?.effect ?? null;
      node.hops = hit?.hops ?? null;
    }
  }

  clearImpact() {
    this.pendingImpact = null;
    this.impactByService = new Map();
    this.#applyImpact();
    this.waveActive = false;
  }

  replay() {
    this.waveStart = performance.now();
    this.waveActive = true;
  }

  focus(serviceId) {
    const node = this.nodes.get(serviceId);
    if (!node) return;
    // Swing the camera so the focused node faces us, without snapping.
    this.spin.autoSpin = false;
    this.spin.theta = Math.atan2(node.pos.x, node.pos.z);
    this.focused = serviceId;
  }

  /** One step of a small force-directed layout: repulsion, spring edges, centring. */
  #layout(dt) {
    const nodes = [...this.nodes.values()];

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const delta = a.pos.clone().sub(b.pos);
        const dist = Math.max(2.2, delta.length());
        const force = delta.normalize().multiplyScalar(58 / (dist * dist));
        a.vel.add(force);
        b.vel.sub(force);
      }
      // Gentle pull to origin keeps the cluster centred in frame.
      a.vel.add(a.pos.clone().multiplyScalar(-0.012));
    }

    for (const edge of this.edges) {
      const from = this.nodes.get(edge.from);
      const to = this.nodes.get(edge.to);
      if (!from || !to) continue;
      const delta = to.pos.clone().sub(from.pos);
      const dist = delta.length();
      const force = delta.normalize().multiplyScalar((dist - 7.5) * 0.05);
      from.vel.add(force);
      to.vel.sub(force);
    }

    for (const node of nodes) {
      node.vel.multiplyScalar(0.86);
      node.pos.add(node.vel.clone().multiplyScalar(Math.min(dt, 0.05) * 8));
      node.mesh.position.copy(node.pos);
      node.halo.position.copy(node.pos);
      node.label.position.copy(node.pos).add(new THREE.Vector3(0, node.radius + 1.1, 0));
    }

    for (const edge of this.edges) {
      const from = this.nodes.get(edge.from);
      const to = this.nodes.get(edge.to);
      if (!from || !to) continue;
      edge.line.geometry.setFromPoints([from.pos, to.pos]);
      edge.line.geometry.attributes.position.needsUpdate = true;
    }
  }

  #paint(now) {
    const elapsed = now - this.waveStart;

    for (const [id, node] of this.nodes) {
      const target = new THREE.Color(IDLE);
      let emissiveIntensity = 0;
      let haloOpacity = 0;

      if (node.effect && this.waveActive) {
        const arrivesAt = node.hops * HOP_MS;
        const since = elapsed - arrivesAt;

        if (since > 0) {
          target.setHex(SEVERITY[node.effect] ?? IDLE);
          // A bright flash on arrival that settles to a steady glow, so the eye is drawn
          // to the moment of impact rather than to whichever node is largest.
          const flash = Math.max(0, 1 - since / 700);
          emissiveIntensity = 0.35 + flash * 0.9;
          haloOpacity = 0.1 + flash * 0.32;
        }
      }

      node.mesh.material.color.lerp(target, 0.14);
      node.mesh.material.emissive.lerp(
        target.clone().multiplyScalar(emissiveIntensity),
        0.16,
      );
      node.halo.material.color.copy(target);
      node.halo.material.opacity += (haloOpacity - node.halo.material.opacity) * 0.14;

      const focusScale = this.focused === id || this.hovered === id ? 1.22 : 1;
      node.mesh.scale.lerp(new THREE.Vector3(focusScale, focusScale, focusScale), 0.16);
      node.label.material.opacity += ((this.hovered === id ? 1 : 0.72) - node.label.material.opacity) * 0.15;
    }

    // Edges glow when the failure has crossed them.
    for (const edge of this.edges) {
      const from = this.impactByService.get(edge.from);
      const to = this.impactByService.get(edge.to);
      const live = this.waveActive && from && to;
      const target = new THREE.Color(live ? SEVERITY[from.effect] ?? IDLE : IDLE);
      edge.line.material.color.lerp(target, 0.1);
      const targetOpacity = live ? 0.7 : 0.28;
      edge.line.material.opacity += (targetOpacity - edge.line.material.opacity) * 0.1;
    }
  }

  #hover() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [...this.nodes.values()].map((n) => n.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    const id = hit?.object?.userData?.serviceId ?? null;

    if (id !== this.hovered) {
      this.hovered = id;
      const node = id ? this.nodes.get(id) : null;
      this.onHover(
        node
          ? { id, data: node.data, effect: node.effect, hops: node.hops, cursor: this.cursor }
          : null,
      );
    }
    this.renderer.domElement.style.cursor = id ? 'pointer' : this.dragging ? 'grabbing' : 'grab';
  }

  #frame() {
    const dt = this.clock.getDelta();
    const now = performance.now();

    this.#layout(dt);
    this.#paint(now);
    this.#hover();

    if (this.spin.autoSpin && !this.dragging) this.spin.theta += dt * 0.075;

    const { theta, phi, radius } = this.spin;
    this.camera.position.set(
      Math.sin(theta) * Math.cos(phi) * radius,
      Math.sin(phi) * radius + 2,
      Math.cos(theta) * Math.cos(phi) * radius,
    );
    this.camera.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.camera);
  }
}
