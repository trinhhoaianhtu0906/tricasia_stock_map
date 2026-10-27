import { Component, onMounted, onPatched, onWillStart, onWillUnmount, useRef, useState } from "@odoo/owl";
import { loadJS } from "@web/core/assets";
import { browser } from "@web/core/browser/browser";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { formatFloat } from "@web/views/fields/formatters";
import { standardActionServiceProps } from "@web/webclient/actions/action_service";
import { WarehouseScene } from "./scene3d";

// One grid cell, in SVG units
const CELL = 20;
// Sequential blue, light to dark: near zero recedes toward the surface
const HEAT_STEPS = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const EMPTY_FILL = "#f0efec";
const STORAGE_KEY = "tricasia_stock_map.warehouse_id";
const VIEW_KEY = "tricasia_stock_map.view";
const FLOOR_KEY = "tricasia_stock_map.floor_id";
// Metres from one floor to the next when all floors are shown
const FLOOR_GAP = 5;
// Loaded only when the 3D view opens
const THREE_URL = "/tricasia_stock_map/static/lib/three/three.min.js";

const KINDS = {
    zone: { label: _t("Zone"), size: [8, 6], order: 0, stock: true },
    aisle: { label: _t("Aisle"), size: [8, 2], order: 1 },
    rack: { label: _t("Rack"), size: [4, 2], order: 2, stock: true },
    pallet: { label: _t("Pallet"), size: [1, 1], order: 3, stock: true },
    wall: { label: _t("Wall"), size: [8, 1], order: 4 },
    door: { label: _t("Door"), size: [2, 1], order: 5 },
    text: { label: _t("Label"), size: [4, 1], order: 6 },
};

let nextKey = 1;

export class TricasiaStockMap extends Component {
    static template = "tricasia_stock_map.StockMap";
    static props = { ...standardActionServiceProps };

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.svgRef = useRef("svg");
        this.canvasRef = useRef("canvas");
        this.sceneRef = useRef("scene3d");
        this.scene3d = null;
        this.sceneSignature = null;
        this.kinds = KINDS;
        this.kindList = Object.entries(KINDS).map(([kind, info]) => ({ kind, label: info.label }));
        this.heatSteps = HEAT_STEPS;
        this.emptyFill = EMPTY_FILL;
        this.cell = CELL;
        this.drag = null;
        this.state = useState({
            warehouses: [],
            warehouseId: false,
            canEdit: false,
            locations: [],
            map: false,
            floors: [],
            floorKey: null,
            allFloors: false,
            shapes: [],
            heat: {},
            productSearch: "",
            categId: false,
            categories: [],
            editing: false,
            selectedKey: null,
            hover: null,
            showTable: false,
            view: "3d",
            walking: false,
            threeReady: Boolean(window.THREE),
        });
        onWillStart(async () => {
            let warehouseId = false;
            try {
                warehouseId = parseInt(browser.localStorage.getItem(STORAGE_KEY)) || false;
                this.state.view = browser.localStorage.getItem(VIEW_KEY) || "3d";
            } catch {
                // Storage can be blocked: start on the first warehouse
            }
            this.state.categories = await this.orm.searchRead("product.category", [], ["complete_name"]);
            await this.load(warehouseId);
        });
        onMounted(() => this.syncScene());
        onPatched(() => this.syncScene());
        onWillUnmount(() => this.disposeScene());
    }

    // Loading

    async load(warehouseId) {
        const data = await this.orm.call("tricasia.stock.map", "load_map", [warehouseId]);
        Object.assign(this.state, {
            warehouses: data.warehouses,
            warehouseId: data.warehouse_id,
            canEdit: data.can_edit,
            locations: data.locations,
            editing: false,
            selectedKey: null,
            hover: null,
        });
        this.locationNames = Object.fromEntries(data.locations.map((loc) => [loc.id, loc.name]));
        this.setMap(data.map);
        try {
            browser.localStorage.setItem(STORAGE_KEY, String(data.warehouse_id));
        } catch {
            // Only a convenience
        }
        await this.loadHeat();
    }

    /**
     * @param {Object|false} map {id, floors: [{id, name, width, height, shapes}]}
     * @param {number} [floorIndex] the floor to show, else the remembered one, else the first
     */
    setMap(map, floorIndex = null) {
        this.state.map = map;
        const floors = map ? map.floors.map((floor) => ({
            key: nextKey++,
            id: floor.id,
            name: floor.name,
            width: floor.width,
            height: floor.height,
        })) : [];
        this.state.floors = floors;
        this.state.shapes = map
            ? map.floors.flatMap((floor, index) => floor.shapes.map((shape) => this.fromServer(shape, floors[index].key)))
            : [];
        let floor = floorIndex !== null ? floors[Math.min(floorIndex, floors.length - 1)] : null;
        if (!floor) {
            let floorId = false;
            try {
                floorId = parseInt(browser.localStorage.getItem(FLOOR_KEY)) || false;
            } catch {
                // Start on the first floor
            }
            floor = floors.find((f) => f.id === floorId) || floors[0];
        }
        this.state.floorKey = floor ? floor.key : null;
        if (floors.length < 2) {
            this.state.allFloors = false;
        }
    }

    get floor() {
        return this.state.floors.find((floor) => floor.key === this.state.floorKey);
    }

    get floorIndex() {
        return this.state.floors.findIndex((floor) => floor.key === this.state.floorKey);
    }

    shapesOf(floorKey = this.state.floorKey) {
        return this.state.shapes.filter((shape) => shape.floorKey === floorKey);
    }

    async loadHeat() {
        if (!this.state.map) {
            this.state.heat = {};
            return;
        }
        this.state.heat = await this.orm.call("tricasia.stock.map", "compute_heat", [
            this.state.map.id,
            this.state.productSearch || false,
            this.state.categId || false,
        ]);
    }

    fromServer(shape, floorKey) {
        return {
            key: nextKey++,
            floorKey,
            id: shape.id || false,
            kind: shape.kind,
            label: shape.label || "",
            locationId: shape.location_id || false,
            x: shape.x,
            y: shape.y,
            w: shape.width,
            h: shape.height,
        };
    }

    toServer(shape) {
        return {
            id: shape.id,
            kind: shape.kind,
            label: shape.label,
            location_id: KINDS[shape.kind].stock ? shape.locationId : false,
            x: shape.x,
            y: shape.y,
            width: shape.w,
            height: shape.h,
        };
    }

    // Toolbar

    async onChangeWarehouse(ev) {
        await this.load(parseInt(ev.target.value));
    }

    async onChangeProductSearch(ev) {
        this.state.productSearch = ev.target.value.trim();
        await this.loadHeat();
    }

    async onChangeCategory(ev) {
        this.state.categId = parseInt(ev.target.value) || false;
        await this.loadHeat();
    }

    async onCreateMap() {
        await this.orm.call("tricasia.stock.map", "create_map", [this.state.warehouseId]);
        await this.load(this.state.warehouseId);
        this.state.editing = true;
    }

    onChangeView(view) {
        this.state.view = view;
        this.state.hover = null;
        try {
            browser.localStorage.setItem(VIEW_KEY, view);
        } catch {
            // Only a convenience
        }
    }

    onToggleWalk() {
        this.state.walking = !this.state.walking;
        this.state.hover = null;
        // One walks on a single floor
        if (this.state.walking) {
            this.state.allFloors = false;
        }
        this.scene3d?.setMode(this.state.walking ? "walk" : "orbit");
    }

    onToggleAllFloors() {
        this.state.allFloors = !this.state.allFloors;
        this.state.hover = null;
    }

    // Floors

    onSelectFloor(floor) {
        this.state.floorKey = floor.key;
        this.state.selectedKey = null;
        this.state.hover = null;
        if (floor.id) {
            try {
                browser.localStorage.setItem(FLOOR_KEY, String(floor.id));
            } catch {
                // Only a convenience
            }
        }
    }

    /**
     * @param {boolean} copyWalls start from the walls and doors of the selected floor, the shell of the building
     */
    onAddFloor(copyWalls) {
        const base = this.floor;
        const floor = {
            key: nextKey++,
            id: false,
            name: _t("Floor %s", this.state.floors.length + 1),
            width: base.width,
            height: base.height,
        };
        this.state.floors.push(floor);
        if (copyWalls) {
            for (const shape of this.shapesOf(base.key).filter((s) => ["wall", "door"].includes(s.kind))) {
                this.state.shapes.push({ ...shape, key: nextKey++, id: false, floorKey: floor.key });
            }
        }
        this.onSelectFloor(floor);
    }

    onFloorName(ev) {
        this.floor.name = ev.target.value.trim() || this.floor.name;
    }

    onMoveFloor(delta) {
        const floors = this.state.floors;
        const index = this.floorIndex;
        const target = index + delta;
        if (target < 0 || target >= floors.length) {
            return;
        }
        [floors[index], floors[target]] = [floors[target], floors[index]];
    }

    onDeleteFloor() {
        if (this.state.floors.length < 2) {
            return;
        }
        const remove = () => {
            const index = this.floorIndex;
            const key = this.state.floorKey;
            this.state.shapes = this.state.shapes.filter((shape) => shape.floorKey !== key);
            this.state.floors.splice(index, 1);
            this.onSelectFloor(this.state.floors[Math.max(0, index - 1)]);
        };
        const count = this.shapesOf().length;
        if (!count) {
            remove();
            return;
        }
        this.dialog.add(ConfirmationDialog, {
            body: _t("Delete the floor %(floor)s and its %(count)s shape(s)? It is gone once the map is saved.", {
                floor: this.floor.name,
                count,
            }),
            confirm: remove,
            cancel: () => {},
        });
    }

    onResetView() {
        this.scene3d?.frameAll();
    }

    onToggleTable() {
        this.state.showTable = !this.state.showTable;
    }

    onEdit() {
        this.state.editing = true;
        this.state.hover = null;
    }

    async onSave() {
        const floorIndex = this.floorIndex;
        const map = await this.orm.call("tricasia.stock.map", "save_map", [
            this.state.map.id,
            this.state.floors.map((floor) => ({
                id: floor.id,
                name: floor.name,
                width: floor.width,
                height: floor.height,
                shapes: this.shapesOf(floor.key).map((shape) => this.toServer(shape)),
            })),
        ]);
        this.setMap(map, floorIndex);
        this.state.editing = false;
        this.state.selectedKey = null;
        await this.loadHeat();
        this.notification.add(_t("The map is saved."), { type: "success" });
    }

    async onDiscard() {
        await this.load(this.state.warehouseId);
    }

    // Drawing

    get sortedShapes() {
        return this.shapesOf().sort((a, b) => KINDS[a.kind].order - KINDS[b.kind].order);
    }

    get selected() {
        return this.state.shapes.find((shape) => shape.key === this.state.selectedKey);
    }

    toGrid(ev) {
        const svg = this.svgRef.el;
        const point = svg.createSVGPoint();
        point.x = ev.clientX;
        point.y = ev.clientY;
        const local = point.matrixTransform(svg.getScreenCTM().inverse());
        return { x: local.x / CELL, y: local.y / CELL };
    }

    clamp(shape) {
        const { width, height } = this.state.floors.find((floor) => floor.key === shape.floorKey);
        shape.w = Math.max(1, Math.min(shape.w, width));
        shape.h = Math.max(1, Math.min(shape.h, height));
        shape.x = Math.max(0, Math.min(shape.x, width - shape.w));
        shape.y = Math.max(0, Math.min(shape.y, height - shape.h));
    }

    addShape(kind, x = 0, y = 0) {
        const [w, h] = KINDS[kind].size;
        const shape = {
            key: nextKey++, floorKey: this.state.floorKey, id: false, kind, label: "", locationId: false, x, y, w, h,
        };
        this.clamp(shape);
        this.state.shapes.push(shape);
        this.state.selectedKey = shape.key;
    }

    onPaletteDragStart(ev, kind) {
        ev.dataTransfer.setData("text/plain", kind);
        ev.dataTransfer.effectAllowed = "copy";
    }

    onDragOver(ev) {
        if (this.state.editing) {
            ev.preventDefault(); // Accept the drop
        }
    }

    onDrop(ev) {
        const kind = ev.dataTransfer.getData("text/plain");
        if (!this.state.editing || !KINDS[kind]) {
            return;
        }
        const point = this.toGrid(ev);
        const [w, h] = KINDS[kind].size;
        this.addShape(kind, Math.round(point.x - w / 2), Math.round(point.y - h / 2));
    }

    onShapePointerDown(ev, shape, mode = "move") {
        if (!this.state.editing) {
            return;
        }
        ev.stopPropagation();
        ev.currentTarget.setPointerCapture(ev.pointerId);
        this.state.selectedKey = shape.key;
        const { x, y, w, h } = shape;
        this.drag = { shape, mode, start: this.toGrid(ev), orig: { x, y, w, h } };
    }

    onPointerMove(ev) {
        if (!this.drag) {
            return;
        }
        const { shape, mode, start, orig } = this.drag;
        const point = this.toGrid(ev);
        const dx = Math.round(point.x - start.x);
        const dy = Math.round(point.y - start.y);
        if (mode === "move") {
            shape.x = orig.x + dx;
            shape.y = orig.y + dy;
        } else {
            shape.w = Math.min(orig.w + dx, this.floor.width - orig.x);
            shape.h = Math.min(orig.h + dy, this.floor.height - orig.y);
        }
        this.clamp(shape);
    }

    onPointerUp() {
        this.drag = null;
    }

    onCanvasPointerDown() {
        if (this.state.editing) {
            this.state.selectedKey = null;
        }
    }

    onKeyDown(ev) {
        const shape = this.selected;
        if (!this.state.editing || !shape || ["INPUT", "SELECT"].includes(ev.target.tagName)) {
            return;
        }
        const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (ev.key in moves) {
            ev.preventDefault();
            shape.x += moves[ev.key][0];
            shape.y += moves[ev.key][1];
            this.clamp(shape);
        } else if (ev.key === "Delete" || ev.key === "Backspace") {
            ev.preventDefault();
            this.onDeleteShape();
        }
    }

    // Selected shape

    onShapeField(field, ev) {
        const shape = this.selected;
        let value = ev.target.value;
        if (["x", "y", "w", "h"].includes(field)) {
            value = parseInt(value) || 0;
        } else if (field === "locationId") {
            value = parseInt(value) || false;
            if (value && !shape.label) {
                shape.label = this.locationNames[value].split("/").pop();
            }
        }
        shape[field] = value;
        this.clamp(shape);
    }

    onRotateShape() {
        const shape = this.selected;
        [shape.w, shape.h] = [shape.h, shape.w];
        this.clamp(shape);
    }

    onDuplicateShape() {
        const { kind, label, x, y, w, h } = this.selected;
        // The copy is left unlinked: the next rack or pallet usually holds another location
        this.addShape(kind, x + 1, y + 1);
        Object.assign(this.selected, { label, w, h });
        this.clamp(this.selected);
    }

    onDeleteShape() {
        this.state.shapes = this.state.shapes.filter((shape) => shape.key !== this.state.selectedKey);
        this.state.selectedKey = null;
    }

    onMapSize(field, ev) {
        this.floor[field] = Math.max(5, Math.min(parseInt(ev.target.value) || 0, 200));
        this.shapesOf().forEach((shape) => this.clamp(shape));
    }

    // Heat

    heatOf(shape) {
        return shape.id && this.state.heat[shape.id];
    }

    heatOrZero(shape) {
        return this.heatOf(shape) || { qty: 0, products: 0, levels: [] };
    }

    /**
     * Racks, pallets and zones each have their own scale: a zone adds up its racks and would pale them all.
     * Each floor has its own scale too: a mezzanine of spare parts stays readable next to a full ground floor.
     */
    heatMaxOf(kind, floorKey = this.state.floorKey) {
        const values = this.shapesOf(floorKey)
            .filter((shape) => shape.kind === kind && this.heatOf(shape))
            .map((shape) => this.heatOf(shape).qty);
        return Math.max(0, ...values);
    }

    get heatMax() {
        return this.heatMaxOf("rack") || this.heatMaxOf("pallet") || this.heatMaxOf("zone");
    }

    heatStep(shape) {
        const heat = this.heatOf(shape);
        const value = heat ? heat.qty : 0;
        const max = this.heatMaxOf(shape.kind, shape.floorKey);
        if (!heat || value <= 0 || !max) {
            return -1;
        }
        return Math.min(HEAT_STEPS.length - 1, Math.floor((value / max) * HEAT_STEPS.length));
    }

    shapeFill(shape) {
        if (this.state.editing || !KINDS[shape.kind].stock || !shape.locationId) {
            return null; // Styled by its kind
        }
        const step = this.heatStep(shape);
        return step < 0 ? EMPTY_FILL : HEAT_STEPS[step];
    }

    // 3D

    async loadThree() {
        if (!this.threeLoading) {
            this.threeLoading = loadJS(THREE_URL);
        }
        await this.threeLoading;
        this.state.threeReady = true;
    }

    /**
     * Create, update or drop the 3D scene after each render: it lives in a container Owl leaves empty.
     */
    syncScene() {
        const el = this.sceneRef.el;
        if (this.scene3d && this.scene3d.el !== el) {
            this.disposeScene();
        }
        if (!el) {
            return;
        }
        if (!window.THREE) {
            this.loadThree();
            return;
        }
        if (!this.scene3d) {
            this.scene3d = new WarehouseScene(el, {
                onHover: (hit) => this.onSceneHover(hit),
                onClick: (hit) => this.onSceneClick(hit),
            });
            this.scene3d.setMode(this.state.walking ? "walk" : "orbit");
        }
        const map = this.sceneMap;
        const signature = JSON.stringify(map);
        if (signature !== this.sceneSignature) {
            this.scene3d.setMap(map);
            this.sceneSignature = signature;
        }
    }

    disposeScene() {
        this.scene3d?.dispose();
        this.scene3d = null;
        this.sceneSignature = null;
    }

    /**
     * The levels of a rack, from the bottom: its sub-locations, or the rack itself as one level.
     */
    rackLevels(shape) {
        const heat = this.heatOrZero(shape);
        return heat.levels && heat.levels.length ? heat.levels : [heat];
    }

    /**
     * The levels of all racks of a floor share one scale: a level is a shelf, whatever its rack.
     */
    levelMaxOf(floorKey = this.state.floorKey) {
        const values = this.shapesOf(floorKey)
            .filter((shape) => shape.kind === "rack" && shape.locationId)
            .flatMap((shape) => this.rackLevels(shape).map((level) => level.qty));
        return Math.max(0, ...values);
    }

    heatColor(value, max) {
        if (value <= 0 || !max) {
            return EMPTY_FILL;
        }
        return HEAT_STEPS[Math.min(HEAT_STEPS.length - 1, Math.floor((value / max) * HEAT_STEPS.length))];
    }

    /**
     * From 15% for a little stock to full for the most stocked one: a little stock still shows.
     */
    fillOf(value, max) {
        return value > 0 && max ? 0.15 + 0.85 * Math.min(1, value / max) : 0;
    }

    /**
     * The selected floor, or the whole building stacked from the ground floor up.
     */
    get sceneMap() {
        const floors = this.state.allFloors ? this.state.floors : [this.floor];
        return {
            floors: floors.map((floor) => ({
                elevation: this.state.allFloors ? this.state.floors.indexOf(floor) * FLOOR_GAP : 0,
                width: floor.width,
                height: floor.height,
                active: floor.key === this.state.floorKey,
                items: this.sceneItems(floor.key),
            })),
        };
    }

    sceneItems(floorKey) {
        const levelMax = this.levelMaxOf(floorKey);
        const palletMax = this.heatMaxOf("pallet", floorKey);
        return this.shapesOf(floorKey).map((shape) => {
            const linked = KINDS[shape.kind].stock && shape.locationId;
            const item = {
                key: shape.key,
                kind: shape.kind,
                x: shape.x,
                y: shape.y,
                w: shape.w,
                h: shape.h,
                label: this.shapeTitle(shape),
            };
            if (shape.kind === "rack") {
                const heat = this.heatOf(shape);
                item.hasLevels = Boolean(heat && heat.levels.length);
                item.levels = linked
                    ? this.rackLevels(shape).map((level) => ({
                          color: this.heatColor(level.qty, levelMax),
                          fill: this.fillOf(level.qty, levelMax),
                      }))
                    : [];
            } else if (shape.kind === "pallet") {
                const qty = this.heatOrZero(shape).qty;
                item.color = this.heatColor(qty, palletMax);
                item.fill = linked ? this.fillOf(qty, palletMax) : 0;
            } else if (shape.kind === "zone") {
                item.color = linked ? this.shapeFill(shape) : "#e7f0fc";
                item.opacity = 0.5;
                item.pickable = Boolean(linked);
            }
            return item;
        });
    }

    onSceneHover(hit) {
        const shape = hit && this.state.shapes.find((s) => s.key === hit.key);
        if (!shape || !shape.locationId) {
            if (this.state.hover) {
                this.state.hover = null;
            }
            return;
        }
        const box = this.canvasRef.el.getBoundingClientRect();
        this.state.hover = {
            key: shape.key,
            level: hit.level,
            left: hit.clientX - box.left + 12,
            top: hit.clientY - box.top + 12,
        };
    }

    onSceneClick(hit) {
        const shape = this.state.shapes.find((s) => s.key === hit.key);
        if (!shape) {
            return;
        }
        const level = hit.level !== null ? this.heatOrZero(shape).levels[hit.level] : null;
        this.onShapeClick(shape, level ? level.location_id : false);
    }

    /**
     * What the tooltip shows: the hovered shape, or the hovered level of a rack.
     */
    get hoverInfo() {
        const shape = this.hoverShape;
        if (!shape) {
            return null;
        }
        const heat = this.heatOrZero(shape);
        const level = heat.levels[this.state.hover.level];
        if (level) {
            return {
                title: `${this.shapeTitle(shape)} / ${level.name}`,
                subtitle: this.locationNames[level.location_id],
                heat: level,
            };
        }
        return { title: this.shapeTitle(shape), subtitle: this.locationNames[shape.locationId], heat };
    }

    get legendMax() {
        return this.state.view === "3d" ? this.levelMaxOf() || this.heatMaxOf("pallet") : this.heatMax;
    }

    shapeTextClass(shape) {
        return !this.state.editing && this.heatStep(shape) >= 3 ? "o_tsm_text_light" : "";
    }

    shapeClass(shape) {
        const classes = [`o_tsm_shape o_tsm_${shape.kind}`];
        if (KINDS[shape.kind].stock && !shape.locationId) {
            classes.push("o_tsm_unlinked");
        }
        if (shape.key === this.state.selectedKey) {
            classes.push("o_tsm_selected");
        }
        if (!this.state.editing && shape.locationId) {
            classes.push("o_tsm_clickable");
        }
        return classes.join(" ");
    }

    formatQty(value, exact = false) {
        if (exact) {
            return formatFloat(value, { digits: [16, 2] });
        }
        if (Math.abs(value) < 1000) {
            return formatFloat(value, { digits: [16, Number.isInteger(value) ? 0 : 1] });
        }
        return formatFloat(value, { humanReadable: true, decimals: 1 });
    }

    shapeTitle(shape) {
        return shape.label || (shape.locationId && this.locationNames[shape.locationId]) || "";
    }

    onShapeEnter(ev, shape) {
        if (this.state.editing || !shape.locationId) {
            return;
        }
        const box = this.canvasRef.el.getBoundingClientRect();
        this.state.hover = {
            key: shape.key,
            left: ev.clientX - box.left + this.canvasRef.el.scrollLeft + 12,
            top: ev.clientY - box.top + this.canvasRef.el.scrollTop + 12,
        };
    }

    onShapeLeave() {
        this.state.hover = null;
    }

    get hoverShape() {
        return this.state.hover && this.state.shapes.find((shape) => shape.key === this.state.hover.key);
    }

    async onShapeClick(shape, locationId = false) {
        if (this.state.editing || !shape.id || !shape.locationId) {
            return;
        }
        const action = await this.orm.call("tricasia.stock.map", "action_quants", [
            this.state.map.id,
            shape.id,
            this.state.productSearch || false,
            this.state.categId || false,
            locationId,
        ]);
        this.action.doAction(action);
    }

    get tableRows() {
        return this.shapesOf()
            .filter((shape) => shape.id && shape.locationId)
            .map((shape) => ({ shape, heat: this.heatOrZero(shape) }))
            .sort((a, b) => b.heat.qty - a.heat.qty);
    }

    get unlinkedCount() {
        return this.shapesOf().filter((shape) => KINDS[shape.kind].stock && !shape.locationId).length;
    }

    /**
     * The stock of each floor, for the floor tabs: what is where at a glance.
     */
    floorQty(floor) {
        // Zones overlap the racks and pallets they hold: count only racks and pallets, or zones alone
        const shapes = this.shapesOf(floor.key).filter((shape) => this.heatOf(shape));
        const holders = shapes.filter((shape) => shape.kind !== "zone");
        return (holders.length ? holders : shapes).reduce((sum, shape) => sum + this.heatOf(shape).qty, 0);
    }
}

registry.category("actions").add("tricasia_stock_map", TricasiaStockMap);
