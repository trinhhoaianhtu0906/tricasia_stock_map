// The warehouse in 3D with three.js (window.THREE, loaded on demand): orbit around it or walk through it.
// One grid cell is one metre: x goes east, y (the map rows) goes south as the world z axis.

const LEVEL_HEIGHT = 1.4;
const PALLET_HEIGHT = 0.15;
const PALLET_LOAD = 1.6; // the tallest load, on the most stocked pallet
const WALL_HEIGHT = 3.2;
const EYE_HEIGHT = 1.65;
const WALK_SPEED = 3; // metres per second, twice as fast with Shift
const BODY_RADIUS = 0.3;
const COLORS = {
    background: 0xeef1f5,
    floor: 0xf4f2ee,
    grid: 0xe1ded6,
    aisle: 0xdedad0,
    wall: 0xc9c6bd,
    door: 0xe0b45c,
    post: 0x4a4a48,
    beam: 0xd9822b,
    pallet: 0xb88a5a,
    unlinked: 0xffffff,
};

export class WarehouseScene {
    /**
     * @param {HTMLElement} el container, focusable for the walking keys
     * @param {Object} callbacks onHover({key, level, clientX, clientY} or null), onClick({key, level})
     */
    constructor(el, callbacks) {
        const THREE = window.THREE;
        this.THREE = THREE;
        this.el = el;
        this.callbacks = callbacks;
        this.mode = "orbit";
        this.keys = new Set();
        this.obstacles = [];
        this.pickables = [];
        this.mapSize = null;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        el.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(COLORS.background);
        this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a968c, 0.85));
        this.sun = new THREE.DirectionalLight(0xffffff, 0.7);
        this.sun.castShadow = true;
        this.sun.shadow.mapSize.set(2048, 2048);
        this.scene.add(this.sun, this.sun.target);
        this.content = new THREE.Group();
        this.scene.add(this.content);
        this.raycaster = new THREE.Raycaster();

        // Orbit: around a target; walk: from the eye
        this.orbit = { target: new THREE.Vector3(), radius: 30, theta: Math.PI / 4, phi: 0.9 };
        this.walk = { position: new THREE.Vector3(), yaw: 0, pitch: 0 };

        this._bind();
        this.resizeObserver = new ResizeObserver(() => this._resize());
        this.resizeObserver.observe(el);
        this._resize();
        this.lastTime = performance.now();
        this._loop = this._loop.bind(this);
        this.frame = requestAnimationFrame(this._loop);
    }

    dispose() {
        cancelAnimationFrame(this.frame);
        this.resizeObserver.disconnect();
        for (const [target, type, handler] of this.listeners) {
            target.removeEventListener(type, handler);
        }
        this._clear();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    // Content

    /**
     * @param {Object} map {width, height, items: [{key, kind, x, y, w, h, label, color, opacity, pickable,
     *     fill (pallets, 0 to 1), hasLevels, levels: [{color, fill (0 to 1)}]}]}
     */
    setMap(map) {
        this._clear();
        const sizeChanged = !this.mapSize || this.mapSize[0] !== map.width || this.mapSize[1] !== map.height;
        this.mapSize = [map.width, map.height];
        this._addFloor(map.width, map.height);
        const doors = map.items.filter((item) => item.kind === "door");
        for (const item of map.items) {
            switch (item.kind) {
                case "rack":
                    this._addRack(item);
                    break;
                case "pallet":
                    this._addPallet(item);
                    break;
                case "zone":
                case "aisle":
                    this._addFloorArea(item);
                    break;
                case "wall":
                    this._addWall(item, doors);
                    break;
                case "door":
                    this._addDoor(item);
                    break;
                default:
                    this._addLabel(item.label, item.x + item.w / 2, 0.4, item.y + item.h / 2, 0.8);
            }
        }
        this._placeSun(map.width, map.height);
        if (sizeChanged) {
            this.frameAll();
            this._placeWalker(doors);
        }
    }

    _clear() {
        this.content.traverse((object) => {
            object.geometry?.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
                material?.map?.dispose();
                material?.dispose();
            }
        });
        this.content.clear();
        this.obstacles = [];
        this.pickables = [];
    }

    _box(w, h, d, color, { x, y, z, shadow = true, opacity = 1 }) {
        const THREE = this.THREE;
        const material = new THREE.MeshStandardMaterial({
            color, roughness: 0.8, transparent: opacity < 1, opacity,
        });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
        mesh.position.set(x, y, z);
        mesh.castShadow = shadow;
        mesh.receiveShadow = true;
        this.content.add(mesh);
        return mesh;
    }

    _addFloor(width, height) {
        const THREE = this.THREE;
        this._box(width, 0.2, height, COLORS.floor, { x: width / 2, y: -0.1, z: height / 2, shadow: false });
        const points = [];
        for (let x = 0; x <= width; x++) {
            points.push(new THREE.Vector3(x, 0.002, 0), new THREE.Vector3(x, 0.002, height));
        }
        for (let z = 0; z <= height; z++) {
            points.push(new THREE.Vector3(0, 0.002, z), new THREE.Vector3(width, 0.002, z));
        }
        const grid = new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: COLORS.grid })
        );
        this.content.add(grid);
    }

    _addFloorArea(item) {
        const isZone = item.kind === "zone";
        const mesh = this._box(item.w, 0.02, item.h, item.color || COLORS.aisle, {
            x: item.x + item.w / 2,
            y: isZone ? 0.012 : 0.006,
            z: item.y + item.h / 2,
            shadow: false,
            opacity: item.opacity ?? 1,
        });
        if (isZone && item.pickable) {
            mesh.userData = { key: item.key, level: null };
            this.pickables.push(mesh);
        }
        if (item.label) {
            // At the front edge: the centre of a zone is under its racks
            this._addLabel(item.label, item.x + item.w / 2, 0.5, item.y + item.h - 0.6, 0.7);
        }
    }

    _addWall(item, doors) {
        // Walls are cut where a door stands, so one can walk through it
        const horizontal = item.w >= item.h;
        const [start, end] = horizontal ? [item.x, item.x + item.w] : [item.y, item.y + item.h];
        const cuts = doors
            .filter((door) => door.x < item.x + item.w && item.x < door.x + door.w &&
                door.y < item.y + item.h && item.y < door.y + door.h)
            .map((door) => (horizontal ? [door.x, door.x + door.w] : [door.y, door.y + door.h]))
            .sort((a, b) => a[0] - b[0]);
        let cursor = start;
        const segments = [];
        for (const [from, to] of cuts) {
            if (from > cursor) {
                segments.push([cursor, Math.min(from, end)]);
            }
            cursor = Math.max(cursor, to);
        }
        if (cursor < end) {
            segments.push([cursor, end]);
        }
        for (const [from, to] of segments) {
            const rect = horizontal
                ? { x: from, y: item.y, w: to - from, h: item.h }
                : { x: item.x, y: from, w: item.w, h: to - from };
            this._box(rect.w, WALL_HEIGHT, rect.h, COLORS.wall, {
                x: rect.x + rect.w / 2, y: WALL_HEIGHT / 2, z: rect.y + rect.h / 2,
            });
            this.obstacles.push(rect);
        }
    }

    _addDoor(item) {
        // A frame: two posts and a lintel
        const horizontal = item.w >= item.h;
        const thickness = 0.15;
        const top = WALL_HEIGHT * 0.75;
        const cx = item.x + item.w / 2;
        const cz = item.y + item.h / 2;
        const span = horizontal ? item.w : item.h;
        for (const side of [-1, 1]) {
            const offset = side * (span / 2 - thickness / 2);
            this._box(horizontal ? thickness : item.w, top, horizontal ? item.h : thickness, COLORS.door, {
                x: horizontal ? cx + offset : cx, y: top / 2, z: horizontal ? cz : cz + offset,
            });
        }
        this._box(item.w, 0.25, item.h, COLORS.door, {
            x: cx, y: top + 0.125, z: cz,
        });
        this._box(item.w, WALL_HEIGHT - top - 0.25, item.h, COLORS.wall, {
            x: cx, y: top + 0.25 + (WALL_HEIGHT - top - 0.25) / 2, z: cz,
        });
        if (item.label) {
            // Above the wall it is cut in, not inside it
            this._addLabel(item.label, cx, WALL_HEIGHT + 0.5, cz, 0.6);
        }
    }

    _addRack(item) {
        const THREE = this.THREE;
        const levels = item.levels.length ? item.levels : [{ color: null, fill: 0 }];
        const height = levels.length * LEVEL_HEIGHT;
        const x0 = item.x + 0.1;
        const z0 = item.y + 0.1;
        const w = item.w - 0.2;
        const d = item.h - 0.2;
        const post = 0.09;
        // Posts at the corners, and between bays of about 2.5 metres along the long side
        const along = w >= d;
        const length = along ? w : d;
        const bays = Math.max(1, Math.round(length / 2.5));
        for (let bay = 0; bay <= bays; bay++) {
            const t = (bay / bays) * (length - post) + post / 2;
            for (const side of [post / 2, (along ? d : w) - post / 2]) {
                const [px, pz] = along ? [x0 + t, z0 + side] : [x0 + side, z0 + t];
                this._box(post, height + 0.15, post, COLORS.post, { x: px, y: (height + 0.15) / 2, z: pz });
            }
        }
        levels.forEach((level, index) => {
            const base = index * LEVEL_HEIGHT;
            // Beams carrying the shelf, the deck on them
            this._box(w, 0.06, d, COLORS.beam, { x: x0 + w / 2, y: base + 0.12, z: z0 + d / 2 });
            if (level.fill > 0) {
                const goods = (LEVEL_HEIGHT - 0.4) * level.fill;
                this._box(w - 0.3, goods, d - 0.3, level.color, {
                    x: x0 + w / 2, y: base + 0.15 + goods / 2, z: z0 + d / 2,
                });
            }
            // The volume of the level, for the pointer
            const hit = new THREE.Mesh(
                new THREE.BoxGeometry(w, LEVEL_HEIGHT, d),
                new THREE.MeshBasicMaterial({ visible: false })
            );
            hit.position.set(x0 + w / 2, base + LEVEL_HEIGHT / 2, z0 + d / 2);
            hit.userData = { key: item.key, level: item.hasLevels ? index : null };
            this.content.add(hit);
            this.pickables.push(hit);
        });
        this._box(w, 0.06, d, COLORS.beam, { x: x0 + w / 2, y: height + 0.05, z: z0 + d / 2 });
        if (item.label) {
            this._addLabel(item.label, item.x + item.w / 2, height + 0.6, item.y + item.h / 2, 0.7);
        }
        this.obstacles.push({ x: item.x, y: item.y, w: item.w, h: item.h });
    }

    _addPallet(item) {
        const THREE = this.THREE;
        const x0 = item.x + 0.1;
        const z0 = item.y + 0.1;
        const w = item.w - 0.2;
        const d = item.h - 0.2;
        // Three runners under a deck of slats, like a real wooden pallet
        const along = w >= d;
        for (const t of [0.05, 0.5, 0.95]) {
            const [rx, rz] = along ? [x0 + w / 2, z0 + d * t] : [x0 + w * t, z0 + d / 2];
            this._box(along ? w : 0.1, PALLET_HEIGHT - 0.03, along ? 0.1 : d, COLORS.pallet, {
                x: rx, y: (PALLET_HEIGHT - 0.03) / 2, z: rz,
            });
        }
        const slats = Math.max(3, Math.round((along ? w : d) / 0.18));
        for (let index = 0; index < slats; index++) {
            const t = (index + 0.5) / slats;
            const [sx, sz] = along ? [x0 + w * t, z0 + d / 2] : [x0 + w / 2, z0 + d * t];
            this._box(along ? 0.1 : w, 0.03, along ? d : 0.1, COLORS.pallet, {
                x: sx, y: PALLET_HEIGHT - 0.015, z: sz,
            });
        }
        const load = item.fill > 0 ? PALLET_LOAD * item.fill : 0;
        if (load) {
            this._box(w - 0.1, load, d - 0.1, item.color, {
                x: x0 + w / 2, y: PALLET_HEIGHT + load / 2, z: z0 + d / 2,
            });
        }
        // The volume of the pallet and its load, for the pointer
        const height = PALLET_HEIGHT + Math.max(load, 0.4);
        const hit = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), new THREE.MeshBasicMaterial({ visible: false }));
        hit.position.set(x0 + w / 2, height / 2, z0 + d / 2);
        hit.userData = { key: item.key, level: null };
        this.content.add(hit);
        this.pickables.push(hit);
        if (item.label) {
            this._addLabel(item.label, item.x + item.w / 2, height + 0.4, item.y + item.h / 2, 0.5);
        }
        this.obstacles.push({ x: item.x, y: item.y, w: item.w, h: item.h });
    }

    _addLabel(text, x, y, z, size) {
        if (!text) {
            return;
        }
        const THREE = this.THREE;
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        const font = "600 48px sans-serif";
        context.font = font;
        canvas.width = Math.ceil(context.measureText(text).width) + 32;
        canvas.height = 72;
        context.font = font;
        context.fillStyle = "rgba(255, 255, 255, 0.85)";
        context.beginPath();
        context.roundRect?.(0, 0, canvas.width, canvas.height, 16);
        context.fill();
        context.fillStyle = "#1f1f1d";
        context.textBaseline = "middle";
        context.fillText(text, 16, canvas.height / 2 + 2);
        const texture = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false }));
        sprite.scale.set((size * canvas.width) / canvas.height, size, 1);
        sprite.position.set(x, y, z);
        this.content.add(sprite);
    }

    _placeSun(width, height) {
        const size = Math.max(width, height);
        this.sun.position.set(width * 0.3, size * 1.2, height * -0.2);
        this.sun.target.position.set(width / 2, 0, height / 2);
        const camera = this.sun.shadow.camera;
        camera.left = camera.bottom = -size;
        camera.right = camera.top = size;
        camera.far = size * 4;
        camera.updateProjectionMatrix();
    }

    // Camera

    setMode(mode) {
        this.mode = mode;
        this.keys.clear();
        if (mode === "walk") {
            this.el.focus();
        }
    }

    frameAll() {
        const [width, height] = this.mapSize;
        this.orbit.target.set(width / 2, 0, height / 2);
        this.orbit.radius = Math.max(width, height) * 0.85;
        this.orbit.theta = Math.PI / 4;
        this.orbit.phi = 0.9;
    }

    _placeWalker(doors) {
        // Just inside the first door, facing the middle; else in the middle
        const [width, height] = this.mapSize;
        const middle = [width / 2, height / 2];
        let start = middle;
        if (doors.length) {
            const door = doors[0];
            const at = [door.x + door.w / 2, door.y + door.h / 2];
            const toward = [middle[0] - at[0], middle[1] - at[1]];
            const length = Math.hypot(...toward) || 1;
            start = [at[0] + (toward[0] / length) * 1.5, at[1] + (toward[1] / length) * 1.5];
        }
        this.walk.position.set(start[0], EYE_HEIGHT, start[1]);
        this.walk.yaw = Math.atan2(-(middle[0] - start[0]), -(middle[1] - start[1]));
        this.walk.pitch = 0;
    }

    _updateCamera() {
        if (this.mode === "walk") {
            const { position, yaw, pitch } = this.walk;
            this.camera.position.copy(position);
            this.camera.rotation.set(pitch, yaw, 0, "YXZ");
        } else {
            const { target, radius, theta, phi } = this.orbit;
            this.camera.position.set(
                target.x + radius * Math.sin(phi) * Math.sin(theta),
                target.y + radius * Math.cos(phi),
                target.z + radius * Math.sin(phi) * Math.cos(theta)
            );
            this.camera.lookAt(target);
        }
    }

    _blocked(x, z) {
        if (!this.mapSize) {
            return false;
        }
        const [width, height] = this.mapSize;
        if (x < BODY_RADIUS || z < BODY_RADIUS || x > width - BODY_RADIUS || z > height - BODY_RADIUS) {
            return true;
        }
        return this.obstacles.some((rect) => x > rect.x - BODY_RADIUS && x < rect.x + rect.w + BODY_RADIUS &&
            z > rect.y - BODY_RADIUS && z < rect.y + rect.h + BODY_RADIUS);
    }

    _step(seconds) {
        if (this.mode !== "walk" || !this.keys.size) {
            return;
        }
        const has = (...codes) => codes.some((code) => this.keys.has(code));
        const forward = (has("KeyW", "ArrowUp") ? 1 : 0) - (has("KeyS", "ArrowDown") ? 1 : 0);
        const strafe = (has("KeyD", "ArrowRight") ? 1 : 0) - (has("KeyA", "ArrowLeft") ? 1 : 0);
        if (!forward && !strafe) {
            return;
        }
        const speed = WALK_SPEED * (has("ShiftLeft", "ShiftRight") ? 2 : 1) * seconds;
        const { position, yaw } = this.walk;
        const dx = (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed;
        const dz = (-Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * speed;
        // Each axis on its own: one slides along a rack instead of sticking to it
        if (!this._blocked(position.x + dx, position.z)) {
            position.x += dx;
        }
        if (!this._blocked(position.x, position.z + dz)) {
            position.z += dz;
        }
    }

    // Events

    _bind() {
        const canvas = this.renderer.domElement;
        this.listeners = [
            [canvas, "pointerdown", (ev) => this._onPointerDown(ev)],
            [canvas, "pointermove", (ev) => this._onPointerMove(ev)],
            [canvas, "pointerup", (ev) => this._onPointerUp(ev)],
            [canvas, "pointerleave", () => this.callbacks.onHover(null)],
            [canvas, "wheel", (ev) => this._onWheel(ev)],
            [canvas, "contextmenu", (ev) => ev.preventDefault()],
            [this.el, "keydown", (ev) => this._onKey(ev, true)],
            [this.el, "keyup", (ev) => this._onKey(ev, false)],
            [this.el, "blur", () => this.keys.clear()],
        ];
        for (const [target, type, handler] of this.listeners) {
            target.addEventListener(type, handler, type === "wheel" ? { passive: false } : undefined);
        }
    }

    _onPointerDown(ev) {
        this.el.focus();
        this.drag = { x: ev.clientX, y: ev.clientY, moved: 0, pan: ev.button === 2 || ev.shiftKey };
        ev.target.setPointerCapture(ev.pointerId);
    }

    _onPointerMove(ev) {
        if (!this.drag) {
            this._hover(ev);
            return;
        }
        const dx = ev.clientX - this.drag.x;
        const dy = ev.clientY - this.drag.y;
        this.drag.x = ev.clientX;
        this.drag.y = ev.clientY;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        this.callbacks.onHover(null);
        if (this.mode === "walk") {
            this.walk.yaw -= dx * 0.004;
            this.walk.pitch = Math.max(-1.2, Math.min(1.2, this.walk.pitch - dy * 0.004));
        } else if (this.drag.pan) {
            const scale = this.orbit.radius * 0.0015;
            const { theta } = this.orbit;
            this.orbit.target.x -= (Math.cos(theta) * dx + Math.sin(theta) * dy) * scale;
            this.orbit.target.z -= (-Math.sin(theta) * dx + Math.cos(theta) * dy) * scale;
        } else {
            this.orbit.theta -= dx * 0.006;
            this.orbit.phi = Math.max(0.15, Math.min(1.5, this.orbit.phi - dy * 0.006));
        }
    }

    _onPointerUp(ev) {
        const drag = this.drag;
        this.drag = null;
        if (drag && drag.moved < 5) {
            const hit = this._pick(ev);
            if (hit) {
                this.callbacks.onClick(hit);
            }
        }
    }

    _onWheel(ev) {
        ev.preventDefault();
        if (this.mode === "walk") {
            return;
        }
        const size = this.mapSize ? Math.max(...this.mapSize) : 40;
        this.orbit.radius = Math.max(3, Math.min(size * 3, this.orbit.radius * (ev.deltaY > 0 ? 1.1 : 0.9)));
    }

    _onKey(ev, down) {
        const codes = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
            "ShiftLeft", "ShiftRight"];
        if (this.mode !== "walk" || !codes.includes(ev.code)) {
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        if (down) {
            this.keys.add(ev.code);
        } else {
            this.keys.delete(ev.code);
        }
    }

    _pick(ev) {
        const box = this.renderer.domElement.getBoundingClientRect();
        const pointer = new this.THREE.Vector2(
            ((ev.clientX - box.left) / box.width) * 2 - 1,
            -((ev.clientY - box.top) / box.height) * 2 + 1
        );
        this.raycaster.setFromCamera(pointer, this.camera);
        const [hit] = this.raycaster.intersectObjects(this.pickables, false);
        return hit ? { ...hit.object.userData } : null;
    }

    _hover(ev) {
        const hit = this._pick(ev);
        this.callbacks.onHover(hit && { ...hit, clientX: ev.clientX, clientY: ev.clientY });
    }

    // Rendering

    _resize() {
        const { clientWidth, clientHeight } = this.el;
        if (!clientWidth || !clientHeight) {
            return;
        }
        this.renderer.setSize(clientWidth, clientHeight);
        this.camera.aspect = clientWidth / clientHeight;
        this.camera.updateProjectionMatrix();
    }

    _loop(time) {
        const seconds = Math.min(0.1, (time - this.lastTime) / 1000);
        this.lastTime = time;
        this._step(seconds);
        this._updateCamera();
        this.renderer.render(this.scene, this.camera);
        this.frame = requestAnimationFrame(this._loop);
    }
}
