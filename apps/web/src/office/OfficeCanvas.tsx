/**
 * The 3D office.
 *
 * Plain imperative three.js, driven by one `requestAnimationFrame` loop:
 *
 *   renderer + perspective camera + OrbitControls
 *   a light rig and a scene environment taken from the floor's style
 *   office.glb loaded once, anchors indexed by node name
 *   one procedural avatar per employee, placed by looking its seat up
 *
 * React never re-creates the scene: the mount effect runs once, and data
 * changes are pushed into the live scene through a small imperative API kept in
 * a ref. That is what keeps the office usable while runs stream - no remounts,
 * no WebGL context churn.
 *
 * Every floor is *dressed* from its own style on the way in: materials are
 * remapped by role, so the hand-authored core office and the generated room
 * modules take the same palette even though they share no material names.
 *
 * The view never crashes on missing data: an unknown seat parks the employee on
 * the bench row (and says so in the overlay), an employee with a null seat is
 * parked the same way, and a failed model load shows a real error state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type {
  EmployeeState,
  EmployeeStatus,
  OfficeStyle,
  Role,
  RoleAppearance,
  VendorState,
  VendorStatus,
  WorkspaceSummary,
} from '@dev3d/core';

import { usePrefersReducedMotion, useStoredState } from '../app/hooks';
import { useOffice, useSelection, useStore } from '../app/StoreContext';
import { FALLBACK_APPEARANCE } from '../app/store';
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from '../app/status';
import { VENDOR_STATUS_COLOR, VENDOR_STATUS_LABEL } from '../app/status';
import { StylePanel } from '../console/StylePanel';
import { indexAnchors, roomLabel } from './anchors';
import { floorOffset, floorVisibility, resolveFloorId } from './floors';
import type { AnchorStats, OfficeAnchors } from './anchors';
import { createAvatar } from './avatar';
import { createVendorAvatar, defaultVendorColor } from './vendorAvatar';
import type { Avatar } from './avatar';
import { Liveliness } from './liveliness';
import type { LivelinessMember, LivelinessSpot } from './liveliness';
import { buildNavGrid } from './navgrid';
import type { NavGrid, ObstacleBox } from './navgrid';
import { applyStyle, disposeMaterials, dressMaterials, groundGridTexture } from './theme';
import type { AppliedStyle, FloorLighting, FloorMaterials } from './theme';

const OFFICE_URL = `${import.meta.env.BASE_URL}office/office.glb`;
const KIT_URL = `${import.meta.env.BASE_URL}office/blocks.glb`;
/** Camera distance when framing one employee. */
const FOCUS_DISTANCE = 6.4;
/**
 * Camera framing for a vendor terminal.
 *
 * Closer and lower than a person, because a terminal is about 1.1 m tall against
 * a standing employee's ~1.9 m: reusing the person's distance and eye height
 * would leave the kiosk small and sitting in the bottom third of the frame.
 */
const VENDOR_FOCUS_DISTANCE = 4.4;
const VENDOR_FOCUS_HEIGHT = 0.75;
/** Camera distance when framing a whole floor: the office is 22 x 16 m. */
const FLOOR_DISTANCE = 26;
/** Where the liveliness preference is remembered between visits. */
const LIVELINESS_KEY = 'dev3d.liveliness';

/**
 * How attractive each room is as somewhere to stand about.
 *
 * A lounge is where people go when they are not working, so it outranks the
 * rooms named after a job. Anything unrecognised is still somewhere worth
 * walking to, because a floor can grow a room nobody has thought about yet.
 */
const SPOT_WEIGHT: Record<string, number> = {
  Lounge: 2.4,
  Lobby: 1.6,
  DevFloor: 1.3,
};

/** A place the walkers derived from the floor plan, rather than from an anchor. */
const DERIVED_SPOT_WEIGHT = 0.5;


export interface AnchorDiscovery {
  seats: string[];
  rooms: string[];
  desks: string[];
  stats: AnchorStats;
  summary: string;
}

export interface OfficeCanvasProps {
  /** Fired once the model is indexed, so the org panel can offer a seat picker. */
  onAnchorsDiscovered?: (discovery: AnchorDiscovery) => void;
}

type ScenePhase =
  | { kind: 'loading'; progress: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export interface SceneSync {
  employees: EmployeeState[];
  roles: Role[];
  /** Every floor in the building, so the scene can build one per organisation. */
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string;
  selectedId: string | null;
  /**
   * The third-party vendors docked on this floor.
   *
   * Installation-wide rather than per-organisation: a vendor is configured by the
   * operator with an environment variable, not by an org chart, so the same bay
   * appears on every floor. That is deliberate - the alternative would be a
   * vendor charged to one team's budget, which is a business decision dev3d has
   * no way to make on an operator's behalf.
   */
  vendors: VendorState[];
  selectedVendorId: string | null;
}

interface SceneApi {
  /**
   * Brings the scene in step with the office: builds or removes floors, shows
   * the active one, re-seats avatars and refreshes statuses.
   */
  syncScene(input: SceneSync): string[];
  setSelected(employeeId: string | null): void;
  /** Select a docked vendor terminal, for the same reason and by the same path. */
  setSelectedVendor(vendorId: string | null): void;
  setReducedMotion(reduced: boolean): void;
  /** Turns the idle wandering on or off without rebuilding the scene. */
  setLiveliness(enabled: boolean): void;
  resetView(): void;
  dispose(): void;
}

function appearanceFor(role: Role | undefined): RoleAppearance {
  return role?.appearance ?? FALLBACK_APPEARANCE;
}

/**
 * The parts of a floor a person cannot walk through.
 *
 * Everything standing in the band between the ankle and the head is furniture
 * or architecture, and for both GLBs that means boxes: a desk, a chair, a wall
 * segment, a planted partition. Doors are *gaps* between wall segments rather
 * than holes cut in one, so a footprint is an exact description and the grid
 * built from these is exact with it - which is the whole reason the office can
 * be walked without anyone authoring a navmesh.
 *
 * The band is measured from the floor the geometry stands on, not from the
 * world, or every floor above the ground would be read as empty space.
 */
function obstacleBoxesOf(root: THREE.Object3D, floorY: number): ObstacleBox[] {
  const boxes: ObstacleBox[] = [];
  const bounds = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    bounds.setFromObject(mesh);
    if (bounds.max.y < floorY + 0.25 || bounds.min.y > floorY + 1.75) return;
    boxes.push({ minX: bounds.min.x, minZ: bounds.min.z, maxX: bounds.max.x, maxZ: bounds.max.z });
  });
  return boxes;
}

/** Releases every geometry/material under a subtree (ours or the loaded model). */
function disposeObject3D(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const entry of material) materials.add(entry);
    else if (material) materials.add(material);
  });
  for (const material of materials) material.dispose();
}

export function OfficeCanvas({ onAnchorsDiscovered }: OfficeCanvasProps) {
  const store = useStore();
  const office = useOffice();
  const selection = useSelection();
  const reducedMotion = usePrefersReducedMotion();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const onAnchorsRef = useRef<OfficeCanvasProps['onAnchorsDiscovered']>(onAnchorsDiscovered);
  onAnchorsRef.current = onAnchorsDiscovered;

  /**
   * Whether idle employees get up and walk about.
   *
   * Remembered, because somebody who turned the office still for a screenshot
   * should not have to turn it off again after a refresh. Reduced motion beats
   * it: a system that asks for less movement is not asking to be asked twice.
   */
  const [livelinessWanted, setLivelinessWanted] = useStoredState(LIVELINESS_KEY, 'on');
  const livelinessOn = livelinessWanted !== 'off';
  const livelinessRef = useRef(livelinessOn);
  livelinessRef.current = livelinessOn;
  const livelinessActive = livelinessOn && !reducedMotion;

  const [phase, setPhase] = useState<ScenePhase>({ kind: 'loading', progress: 0 });
  const [parked, setParked] = useState<string[]>([]);
  /**
   * Whether the block kit has settled, one way or the other.
   *
   * The floors are rebuilt when this flips, which is what lets a floor that was
   * drawn before the kit arrived pick up its modules without a reload.
   */
  const [kitReady, setKitReady] = useState(false);
  const [summary, setSummary] = useState<string>('indexing the office model…');

  const employees = office?.employees ?? null;
  const roles = office?.roles ?? null;
  /**
   * The vendor bay.
   *
   * Installation-wide, so every floor docks the same terminals. A vendor is
   * configured by the operator with an environment variable rather than hired by
   * an organisation, and pretending otherwise would mean charging one team for a
   * subscription nobody assigned to it.
   */
  const vendors = office?.vendorBay.vendors ?? null;

  // ------------------------------------------------------------------ the scene
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frame = 0;
    let focusTarget: { point: THREE.Vector3; distance: number } | null = null;
    let selectedId: string | null = null;
    let selectedVendorId: string | null = null;
    let pendingFocus = false;
    let reduced = reducedMotion;
    const avatars = new Map<string, Avatar>();
    /**
     * Vendor terminals, in their own map.
     *
     * A second map rather than one keyed by id, because the two are reconciled
     * and disposed against different lists: an employee missing from
     * `input.employees` is gone, and a vendor missing from `input.vendors` is
     * gone. Merging them would mean one loop that has to know which list each id
     * came from - the discriminator this design avoids everywhere else.
     */
    const vendorAvatars = new Map<string, Avatar<VendorStatus>>();
    /** Latest props, so a sync requested before the model loads is not lost. */
    const employeesRef: EmployeeState[] = [];
    const vendorsRef: VendorState[] = [];
    const workspacesRef: WorkspaceSummary[] = [];
    let activeWorkspaceRef = '';
    const rolesRef: Role[] = [];

    /**
     * The liveliness director: where an idle employee *is*, as opposed to where
     * their seat is. It owns a body from the moment it is configured, and the
     * canvas keeps its hands off anybody the director knows about.
     */
    const liveliness = new Liveliness();
    /** The walkable space of the floor on screen, which is not the whole building. */
    let navGrid: NavGrid | null = null;
    /** What that grid was built from, so it is rebuilt only when the shape changes. */
    let navKey = '';
    /** Statuses as of the last sync: what tells the director who is free. */
    const statusById = new Map<string, EmployeeStatus>();
    /** The last roster and places, so a toggle can re-apply without a state push. */
    let lastMembers: LivelinessMember[] = [];
    let lastSpots: LivelinessSpot[] = [];
    let livelinessWanted = livelinessRef.current;
    const statusOf = (id: string): EmployeeStatus | undefined => statusById.get(id);
    const livelinessEnabled = (): boolean => livelinessWanted && !reduced;

    /** Hand the director the current floor under the current switch. */
    const applyLiveliness = (): void => {
      liveliness.configure({
        members: lastMembers,
        spots: lastSpots,
        nav: navGrid,
        enabled: livelinessEnabled(),
      });
    };

    const clock = new THREE.Clock();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#080a0f');
    scene.fog = new THREE.Fog('#080a0f', 30, 78);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 260);
    camera.position.set(10.5, 11.5, 15.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;
    renderer.domElement.className = 'office-canvas';
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 2.5;
    controls.maxDistance = 60;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(0, 1.1, 0);

    /**
     * The light rig.
     *
     * Every value here is overwritten by the active floor's style in
     * `applyEnvironment`, which is what makes one floor a bright Nordic studio
     * and the next a blacked-out noir room. The numbers below are the shipped
     * default, so the scene is never unlit even for the frame before the first
     * floor arrives.
     */
    const hemisphere = new THREE.HemisphereLight(0x9dc4ff, 0x14161d, 0.72);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(10, 16, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 70;
    keyLight.shadow.camera.left = -18;
    keyLight.shadow.camera.right = 18;
    keyLight.shadow.camera.top = 18;
    keyLight.shadow.camera.bottom = -18;
    keyLight.shadow.bias = -0.0006;
    keyLight.shadow.normalBias = 0.02;
    const fillLight = new THREE.DirectionalLight(0xffd7a3, 0.32);
    fillLight.position.set(-9, 8, -10);
    const rimLight = new THREE.DirectionalLight(0x7dd3fc, 0.28);
    rimLight.position.set(-5, 6, 13);
    scene.add(hemisphere, keyLight, fillLight, rimLight);

    // A shadow-only floor under the model so avatars and desks ground properly.
    const groundGeometry = new THREE.PlaneGeometry(160, 160);
    const groundMaterial = new THREE.ShadowMaterial({ opacity: 0.34 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.012;
    ground.receiveShadow = true;
    scene.add(ground);

    // A faint grid on that floor, so the building stands on something rather
    // than floating in a void. It is part of the style, and a style can turn
    // it off. `depthWrite: false` keeps it from occluding the shadow catcher.
    const groundGridMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshBasicMaterial({
        map: groundGridTexture(),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    groundGridMesh.rotation.x = -Math.PI / 2;
    groundGridMesh.position.y = -0.008;
    groundGridMesh.visible = false;
    scene.add(groundGridMesh);

    // The scene starts lit from the default preset, so the frame before the
    // first floor arrives is not a black viewport.
    applyEnvironment(applyStyle(undefined));

    const officeRoot = new THREE.Group();
    officeRoot.name = 'OfficeRoot';
    scene.add(officeRoot);

    // ------------------------------------------------------------- the building
    const floorsRoot = new THREE.Group();
    floorsRoot.name = 'Floors';
    scene.add(floorsRoot);

    interface Floor {
      group: THREE.Group;
      /** The cloned wall/desk geometry. Toggled independently of the plate. */
      clone: THREE.Object3D;
      slab: THREE.Mesh;
      edges: THREE.LineSegments;
      anchors: OfficeAnchors;
      offset: number;
      /** 1-based floor number, for resolveFloorId's lowest-floor fallback. */
      slotFloor: number;
      /**
       * The grown modules, held separately from the core clone so a floor that
       * gains a room can be rebuilt without touching the core geometry - and so
       * the plate can be resized to cover what the floor has become.
       */
      modules: THREE.Group;
      /** The layout this floor was built from, to detect that it changed. */
      layoutKey: string;
      /**
       * The material set this floor is dressed in. Owned by the floor: the
       * GLB's own materials are shared by every clone, so a floor that repainted
       * them in place would repaint the whole building.
       */
      materials: FloorMaterials;
      /** The style this floor was dressed from, to detect that it changed. */
      styleKey: string;
      /** What that style resolved to, for the rig and the scene. */
      applied: AppliedStyle;
      /** The plate size currently built, so it is only rebuilt when it changes. */
      slabSize: string;
      /**
       * Where to look when this floor is selected: the centre of what it has
       * become, and a distance that fits it in the viewport.
       */
      focus: { x: number; z: number; distance: number };
    }

    const floors = new Map<string, Floor>();
    /**
     * A reusable carrier for `dressMaterials`, which only reads `materials`.
     *
     * The alternative - a fresh `AppliedStyle` per mesh set - is a full palette
     * allocation on every module clone, and modules are cloned by the dozen.
     */
    const styleScratch = { materials: {} as FloorMaterials } as AppliedStyle;
    /** The rig currently in force, so a floor can be re-lit without re-resolving. */
    let activeLighting: FloorLighting | null = null;
    /** The loaded model, cloned once per organisation. */
    let template: THREE.Object3D | null = null;
    /** The block kit: one cloneable group per module kind, keyed by node name. */
    const kit = new Map<string, THREE.Object3D>();

    /** A stable key for a layout, so a rebuild happens only when it really changed. */
    function layoutKeyOf(workspace: WorkspaceSummary): string {
      return workspace.layout.blocks
        .map((block) => `${block.id}:${block.kind}@${block.x},${block.z}r${block.rotation}`)
        .join('|');
    }

    /**
     * A stable key for a floor's look.
     *
     * Compared as a signature rather than by object identity, because the style
     * arrives fresh from the server on every state push - so a reference check
     * would re-dress every floor on every event, and re-dressing is the
     * expensive part.
     */
    function styleKeyOf(style: OfficeStyle | undefined): string {
      return JSON.stringify(style ?? { preset: 'studio' });
    }

    /**
     * Instantiate the modules a floor has grown.
     *
     * Each cloned node is renamed to its namespaced seat id, which is what makes
     * two pods distinguishable: without it both would offer `Seat_POD4_02` and the
     * anchor index would keep whichever loaded first.
     */
    function buildModules(workspace: WorkspaceSummary, materials: FloorMaterials): THREE.Group {
      const group = new THREE.Group();
      group.name = `Modules_${workspace.id}`;
      for (const placed of workspace.layout.blocks) {
        const kind = kit.get(placed.kind) ?? kit.get(`Kit_${placed.kind}`);
        if (!kind) continue;
        const instance = kind.clone(true);
        instance.name = `${placed.id}::${placed.kind}`;
        instance.position.set(placed.x, 0, placed.z);
        instance.rotation.y = (placed.rotation * Math.PI) / 180;
        // Namespacing happens here rather than at index time: the anchor index
        // reads node names, and two modules must not claim the same seat.
        instance.traverse((object) => {
          if (object.name.length > 0 && object !== instance) object.name = `${placed.id}::${object.name}`;
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
        dressMaterials(instance, withMaterials(materials));
        group.add(instance);
      }
      // The floor group already sits at the storey height, so modules stay local.
      return group;
    }
    /** Anchors of the floor being looked at; what avatars are placed against. */
    let activeAnchors: OfficeAnchors | null = null;
    let activeFloorId = '';
    /**
     * The last floor summary reported to the host. Compared as a signature so an
     * unchanged floor does not re-render the HUD on every frame sync - and a
     * floor that grew always does.
     */
    let lastDescribed = '';

    /** The core room's plate extent, before any module was added. */
    const BASE_MIN_X = -11.3;
    const BASE_MAX_X = 11.3;
    const BASE_MIN_Z = -8.3;
    const BASE_MAX_Z = 8.3;

    /**
     * Release a floor's own GPU buffers.
     *
     * Deliberately a narrow list rather than a blanket traverse. The core clone
     * and the module instances share geometry and materials with the templates
     * they were cloned from, so disposing those would tear down every other floor
     * with them - and disposing them on a *rebuild* would do the same to a kit
     * that is still in use.
     *
     * What a floor really owns is its coloured plate and its own material set:
     * those were created for it and for nothing else.
     */
    function disposeFloor(entry: Floor): void {
      entry.slab.geometry.dispose();
      entry.edges.geometry.dispose();
      (entry.slab.material as THREE.Material).dispose();
      (entry.edges.material as THREE.Material).dispose();
      disposeMaterials(entry.materials);
      floorsRoot.remove(entry.group);
    }

    /**
     * Re-dress a floor's core clone in a material set.
     *
     * The clone is only ever re-dressed in place rather than rebuilt: it is three
     * hundred meshes, and a style change has to be cheap enough to follow a
     * colour picker. One pass, because the swap is memoised per distinct
     * material - the clone shares its material objects with the template.
     */
    function dressClone(clone: THREE.Object3D, materials: FloorMaterials): void {
      dressMaterials(clone, withMaterials(materials));
    }

    /** The scratch carrier with a floor's material set in it. */
    function withMaterials(materials: FloorMaterials): AppliedStyle {
      styleScratch.materials = materials;
      return styleScratch;
    }

    /** A thin coloured plate per floor, so the building reads as a stack. */
    function buildSlab(workspace: WorkspaceSummary): { slab: THREE.Mesh; edges: THREE.LineSegments } {
      const color = new THREE.Color(workspace.color ?? '#a78bfa');
      // Created per floor rather than shared with the other storeys, so closing a
      // floor can release its own buffers without the rest of the building having
      // to keep them alive.
      const geometry = new THREE.BoxGeometry(BASE_MAX_X - BASE_MIN_X, 0.24, BASE_MAX_Z - BASE_MIN_Z);
      const slab = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, depthWrite: false }),
      );
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.34 }),
      );
      slab.position.y = -0.12;
      edges.position.y = -0.12;
      return { slab, edges };
    }

    /**
     * Resize a floor's plate to whatever the floor has become.
     *
     * A floor that grew past the core room has to *look* like it did, or the
     * stack in the 3D view lies about the building. The extent is measured from
     * the instanced modules rather than computed from the kit, so it stays right
     * if a module's geometry ever changes shape.
     */
    function applySlabScale(entry: Floor): void {
      const box = new THREE.Box3().setFromObject(entry.modules);
      const minX = box.isEmpty() ? BASE_MIN_X : Math.min(BASE_MIN_X, box.min.x - 0.2);
      const maxX = box.isEmpty() ? BASE_MAX_X : Math.max(BASE_MAX_X, box.max.x + 0.2);
      const minZ = box.isEmpty() ? BASE_MIN_Z : Math.min(BASE_MIN_Z, box.min.z - 0.2);
      const maxZ = box.isEmpty() ? BASE_MAX_Z : Math.max(BASE_MAX_Z, box.max.z + 0.2);

      const width = maxX - minX;
      const depth = maxZ - minZ;
      const centreX = (minX + maxX) / 2;
      const centreZ = (minZ + maxZ) / 2;
      const key = `${width.toFixed(2)}x${depth.toFixed(2)}@${centreX.toFixed(2)},${centreZ.toFixed(2)}`;
      if (entry.slabSize === key) return;

      // Geometry is per floor here, and the shared base plate is only used while
      // the floor is still exactly the core room.
      const geometry = new THREE.BoxGeometry(width, 0.24, depth);
      entry.slab.geometry.dispose();
      entry.slab.geometry = geometry;
      entry.edges.geometry.dispose();
      entry.edges.geometry = new THREE.EdgesGeometry(geometry);
      entry.slab.position.set(centreX, -0.12, centreZ);
      entry.edges.position.set(centreX, -0.12, centreZ);
      entry.slabSize = key;
      entry.focus = {
        x: centreX,
        z: centreZ,
        // Scale the pull-back with the building, so a floor that doubled in size
        // is still framed rather than cropped.
        distance: Math.max(FLOOR_DISTANCE, Math.max(width, depth) * 0.95),
      };
    }

    /**
     * The walkable space of a floor, sampled from that floor's own geometry.
     *
     * Keyed on the layout and the plate size, so a floor that grew a room is
     * re-sampled and a floor that was merely re-dressed is not: where a person
     * can walk depends on where the walls are, never on what colour they are.
     */
    function ensureNav(id: string, entry: Floor | null): NavGrid | null {
      const key = entry ? `${id}|${entry.layoutKey}|${entry.slabSize}` : 'none';
      if (key === navKey) return navGrid;
      navGrid = entry ? buildNavGrid(obstacleBoxesOf(entry.group, entry.offset)) : null;
      navKey = key;
      return navGrid;
    }

    /**
     * Where an idle person may go and stand.
     *
     * The room anchors the model carries are the authored answer - a lounge, a
     * lobby, the middle of the dev floor. On top of those, the grid offers a few
     * points of its own for every region somebody actually occupies, which is
     * what gives a room nobody anchored - a sealed office, a module a floor grew
     * last week - somewhere to pace without anyone having to describe it. Those
     * derived points are weighted low, so the office still has a lounge and a
     * lobby rather than nine interchangeable corners.
     */
    function spotsFor(anchors: OfficeAnchors, grid: NavGrid, regions: Set<number>): LivelinessSpot[] {
      const spots: LivelinessSpot[] = [];
      for (const name of anchors.rooms) {
        const point = anchors.roomPosition(name);
        if (!point) continue;
        const label = roomLabel(name);
        spots.push({ id: name, x: point.x, z: point.z, weight: SPOT_WEIGHT[label] ?? 1.1 });
      }
      for (const region of regions) {
        for (const point of grid.regionSpots(region)) {
          const near = spots.some((spot) => Math.hypot(spot.x - point.x, spot.z - point.z) < 1.6);
          if (near) continue;
          spots.push({
            id: `derived:${region}:${spots.length}`,
            x: point.x,
            z: point.z,
            weight: DERIVED_SPOT_WEIGHT,
          });
        }
      }
      return spots;
    }

    /** Clone the model once per organisation, and drop the floors that closed. */
    function buildFloors(workspaces: WorkspaceSummary[]): void {
      if (!template) return;
      const wanted = new Set(workspaces.map((workspace) => workspace.id));

      for (const [id, floor] of [...floors]) {
        if (wanted.has(id)) continue;
        disposeFloor(floor);
        floors.delete(id);
      }

      for (const workspace of workspaces) {
        const existing = floors.get(workspace.id);
        const key = layoutKeyOf(workspace);
        const styleKey = styleKeyOf(workspace.style);
        const applied =
          existing !== undefined && existing.styleKey === styleKey ? existing.applied : applyStyle(workspace.style);
        const materialSet = applied.materials;
        if (existing) {
          const color = new THREE.Color(workspace.color ?? '#a78bfa');
          (existing.slab.material as THREE.MeshBasicMaterial).color.copy(color);
          (existing.edges.material as THREE.LineBasicMaterial).color.copy(color);
          // A restyled floor is re-dressed in place: the walls are the expensive
          // part to rebuild and nothing about them moved.
          if (existing.styleKey !== styleKey) {
            disposeMaterials(existing.materials);
            existing.materials = materialSet;
            existing.applied = applied;
            existing.styleKey = styleKey;
            dressClone(existing.clone, materialSet);
            if (activeFloorId === workspace.id) applyEnvironment(applied);
          }
          // A floor that grew (or lost) a room is rebuilt in place: the core clone
          // is left alone and only the modules are replaced, because re-cloning
          // 312 meshes to add one pod would stutter the view.
          if (existing.layoutKey !== key) {
            // Detach only: a module instance shares its geometry and materials
            // with the kit template, so disposing here would release buffers the
            // other floors and the next clone are still using.
            existing.group.remove(existing.modules);
            existing.modules = buildModules(workspace, existing.materials);
            existing.group.add(existing.modules);
            existing.layoutKey = key;
            existing.anchors = indexAnchors(existing.group);
            applySlabScale(existing);
            if (activeFloorId === workspace.id) activeAnchors = existing.anchors;
          }
          continue;
        }

        const offset = floorOffset(workspace.floor);
        const group = new THREE.Group();
        group.name = `Floor_${workspace.floor}_${workspace.id}`;
        group.position.y = offset;

        const clone = template.clone(true);
        clone.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
        dressClone(clone, materialSet);
        group.add(clone);

        const modules = buildModules(workspace, materialSet);
        group.add(modules);

        const { slab, edges } = buildSlab(workspace);
        group.add(slab, edges);
        // The group itself stays visible; the clone and the plate are toggled
        // separately, because a hidden parent would hide the plate as well.
        group.visible = true;
        clone.visible = false;
        modules.visible = false;
        slab.visible = false;
        edges.visible = false;
        floorsRoot.add(group);

        // Anchors are read from the group, so every floor's seat positions come
        // out in world space at that floor's height - including the grown modules.
        const entry: Floor = {
          group,
          clone,
          slab,
          edges,
          anchors: indexAnchors(group),
          offset,
          slotFloor: Math.max(1, workspace.floor),
          modules,
          layoutKey: key,
          materials: materialSet,
          styleKey,
          applied,
          slabSize: '',
          focus: { x: 0, z: 0, distance: FLOOR_DISTANCE },
        };
        floors.set(workspace.id, entry);
        applySlabScale(entry);
      }
    }

    /**
     * Point the rig and the scene at one floor's look.
     *
     * Called when the floor being looked at changes and when its style does, so
     * the light rig follows the floor on screen rather than being a property of
     * the building. The lights are directional and already climb with the storey
     * height in `showFloor`, which is why the positions here are relative.
     */
    function applyEnvironment(applied: FloorLighting): void {
      const { lighting, environment } = applied;
      hemisphere.color.set(lighting.skyColor);
      hemisphere.groundColor.set(lighting.groundColor);
      hemisphere.intensity = lighting.ambientIntensity;
      keyLight.color.set(lighting.keyColor);
      keyLight.intensity = lighting.keyIntensity;
      keyLight.castShadow = lighting.shadows;
      keyLight.position.set(lighting.keyPosition.x, lighting.keyPosition.y, lighting.keyPosition.z);
      fillLight.color.set(lighting.fillColor);
      fillLight.intensity = lighting.fillIntensity;
      rimLight.color.set(lighting.rimColor);
      rimLight.intensity = lighting.rimIntensity;
      renderer.toneMappingExposure = lighting.exposure;

      (scene.background as THREE.Color).set(environment.background);
      const fog = scene.fog as THREE.Fog | null;
      if (fog) {
        fog.color.set(environment.fogColor);
        fog.near = environment.fogNear;
        fog.far = environment.fogFar;
      }
      groundMaterial.opacity = environment.groundShadowOpacity;
      groundGridMesh.visible = environment.grid;
      (groundGridMesh.material as THREE.MeshBasicMaterial).color.set(environment.gridColor);
      activeLighting = applied;
    }

    /**
     * Look at one floor. Only the active floor shows its walls - the others keep
     * their coloured plates, which is what makes the building legible as a stack
     * without paying for twenty thousand hidden wall meshes.
     */
    function showFloor(workspaceId: string, frame: boolean): void {
      const id = resolveFloorId(
        [...floors.entries()].map(([key, floor]) => ({ id: key, floor: floor.slotFloor })),
        workspaceId,
      );
      if (id === null) return;
      const entry = floors.get(id);
      if (!entry) return;

      activeFloorId = id;
      activeAnchors = entry.anchors;
      for (const [key, floor] of floors) {
        const { walls, plate } = floorVisibility(key, id);
        floor.clone.visible = walls;
        // A grown module is part of the floor's walls: it shows with them, so a
        // floor you are not looking at never sprouts rooms through its plate.
        floor.modules.visible = walls;
        floor.slab.visible = plate;
        floor.edges.visible = plate;
      }
      ground.position.y = entry.offset - 0.012;
      groundGridMesh.position.y = entry.offset - 0.008;
      // The rig is the floor's own, so switching floors is also switching look.
      applyEnvironment(entry.applied);
      // The lights are directional, so they have to climb with the building or
      // an upper floor ends up lit from underneath - and they are relative to the
      // storey, which is why the climb happens after the style has set them.
      keyLight.position.y += entry.offset;
      fillLight.position.y += entry.offset;
      rimLight.position.y += entry.offset;
      // A grown floor is not centred on the origin any more, and it is wider than
      // the room it started as: framing on (0,0) at a fixed distance would push
      // the new rooms off the edges of the viewport.
      keyLight.target.position.set(entry.focus.x, entry.offset, entry.focus.z);
      keyLight.target.updateMatrixWorld();
      if (frame) {
        focusTarget = {
          point: new THREE.Vector3(entry.focus.x, entry.offset, entry.focus.z),
          distance: entry.focus.distance,
        };
      }
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDown: { x: number; y: number } | null = null;
    let hoveredId: string | null = null;

    const findAvatarId = (object: THREE.Object3D | null): string | null => {
      let cursor: THREE.Object3D | null = object;
      while (cursor) {
        const candidate = cursor.userData.avatarId;
        if (typeof candidate === 'string') return candidate;
        cursor = cursor.parent;
      }
      return null;
    };

    /**
     * What the pointer is over.
     *
     * Tagged rather than a bare id, because an employee and a vendor can share an
     * id in principle - both are strings the server chose - and the two are
     * selected through different store calls. Deciding by "which map is it in"
     * rather than by guessing at the id's shape is what makes that unambiguous.
     */
    type Pick = { kind: 'employee' | 'vendor'; id: string };

    const pickAt = (clientX: number, clientY: number): Pick | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const targets: THREE.Object3D[] = [];
      for (const avatar of avatars.values()) targets.push(avatar.group);
      for (const terminal of vendorAvatars.values()) targets.push(terminal.group);
      const hits = raycaster.intersectObjects(targets, true);
      const first = hits[0];
      if (!first) return null;
      const id = findAvatarId(first.object);
      if (id === null) return null;
      // Vendors are checked first: the two maps are disjoint by construction, so
      // the order only decides the answer for an id in neither, and "it is a
      // vendor" is the cheaper test.
      if (vendorAvatars.has(id)) return { kind: 'vendor', id };
      if (avatars.has(id)) return { kind: 'employee', id };
      return null;
    };

    const onPointerDown = (event: PointerEvent): void => {
      pointerDown = { x: event.clientX, y: event.clientY };
    };

    const onPointerUp = (event: PointerEvent): void => {
      const down = pointerDown;
      pointerDown = null;
      if (!down) return;
      // Ignore the pointer-up that merely ends an orbit drag.
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
      const pick = pickAt(event.clientX, event.clientY);
      if (pick === null) {
        // Empty space clears both: the store's setters keep the two slots
        // mutually exclusive, so clearing one is enough to close the inspector.
        store.selectEmployee(null);
        return;
      }
      if (pick.kind === 'vendor') store.selectVendor(pick.id);
      else store.selectEmployee(pick.id);
    };

    const onPointerMove = (event: PointerEvent): void => {
      const pick = pickAt(event.clientX, event.clientY);
      const id = pick === null ? null : `${pick.kind}:${pick.id}`;
      if (id === hoveredId) return;
      hoveredId = id;
      renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
    };

    const onPointerLeave = (): void => {
      hoveredId = null;
      renderer.domElement.style.cursor = 'grab';
    };

    const canvasElement = renderer.domElement;
    canvasElement.style.cursor = 'grab';
    canvasElement.addEventListener('pointerdown', onPointerDown);
    canvasElement.addEventListener('pointerup', onPointerUp);
    canvasElement.addEventListener('pointermove', onPointerMove);
    canvasElement.addEventListener('pointerleave', onPointerLeave);

    const onContextLost = (event: Event): void => {
      event.preventDefault();
      setPhase({ kind: 'error', message: 'the WebGL context was lost — reload the page to restore the office' });
    };
    (canvasElement as EventTarget).addEventListener('webglcontextlost', onContextLost);

    const resize = (): void => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    window.addEventListener('resize', resize);

    // ------------------------------------------------------------- scene API
    const api: SceneApi = {
      syncScene(input) {
        employeesRef.length = 0;
        employeesRef.push(...input.employees);
        vendorsRef.length = 0;
        vendorsRef.push(...input.vendors);
        rolesRef.length = 0;
        rolesRef.push(...input.roles);
        workspacesRef.length = 0;
        workspacesRef.push(...input.workspaces);
        activeWorkspaceRef = input.activeWorkspaceId;
        selectedId = input.selectedId;
        selectedVendorId = input.selectedVendorId;

        buildFloors(input.workspaces);

        // The usual order is model-then-state, but it can be either way. Until
        // there is a floor to describe, the viewport must not claim there is one.
        //
        // Reported per *signature*, not once: a floor that grew a room has a
        // different seat and room count, and a HUD that still describes the room
        // before it grew is simply wrong.
        const described = floors.get(activeFloorId) ?? floors.values().next().value;
        if (described) {
          const signature = `${activeFloorId}|${described.anchors.describe()}`;
          if (signature !== lastDescribed) {
            lastDescribed = signature;
            setSummary(described.anchors.describe());
            onAnchorsRef.current?.({
              seats: described.anchors.seats,
              rooms: described.anchors.rooms,
              desks: described.anchors.desks,
              stats: described.anchors.stats,
              summary: described.anchors.describe(),
            });
          }
        } else {
          setSummary('the office model is loaded; waiting for the building');
        }

        // Switching organisation is a change of floor, and the camera goes with it.
        if (input.activeWorkspaceId !== activeFloorId) {
          showFloor(input.activeWorkspaceId, true);
        }

        const here = activeAnchors;
        if (!here) return [];

        const roleById = new Map(input.roles.map((role) => [role.id, role]));
        const parkedIds: string[] = [];
        const present = new Set<string>();
        /** The roster this floor's director is given, with where each person sits. */
        const members: LivelinessMember[] = [];
        const regions = new Set<number>();
        let benchIndex = 0;

        statusById.clear();

        for (const employee of input.employees) {
          present.add(employee.id);
          const role = roleById.get(employee.roleId);
          let avatar = avatars.get(employee.id);
          if (!avatar) {
            avatar = createAvatar(employee.id, employee.displayName, appearanceFor(role));
            avatars.set(employee.id, avatar);
            officeRoot.add(avatar.group);
          }

          let home: LivelinessMember['home'];
          const seatName = employee.seatId ?? role?.seatId ?? null;
          const seatPosition = seatName ? here.seatPosition(seatName) : null;
          if (seatPosition && seatName) {
            home = {
              x: seatPosition.x,
              y: seatPosition.y,
              z: seatPosition.z,
              yaw: here.seatFacing(seatName, employee.roomId ?? role?.roomId ?? null),
            };
          } else {
            const bench = here.hotDeskPosition(benchIndex);
            benchIndex += 1;
            parkedIds.push(employee.id);
            home = { x: bench.x, y: bench.y, z: bench.z, yaw: 0 };
          }

          // Once the director knows somebody it owns where they *stand*, and
          // this loop only describes where they sit. Re-placing a body that is
          // mid-errand would teleport it home for a frame on every unrelated
          // state push, which is exactly the flicker this avoids.
          if (liveliness.motionFor(employee.id) === null) {
            avatar.group.position.set(home.x, home.y, home.z);
            avatar.group.rotation.y = home.yaw;
            avatar.setFacing(home.yaw);
          }

          members.push({ id: employee.id, name: employee.displayName, home });
          statusById.set(employee.id, employee.status);
          avatar.setStatus(employee.status);
          avatar.setSelected(employee.id === selectedId);
        }

        for (const [id, avatar] of [...avatars.entries()]) {
          if (present.has(id)) continue;
          avatar.dispose();
          avatars.delete(id);
        }

        // ------------------------------------------------------------- vendors
        //
        // Kept entirely out of the liveliness roster below. A terminal is bolted
        // to the floor of a room: it does not walk, does not stand about, is never
        // handed a bubble, and must not be counted as a body that other people
        // walk around. That is why it is not pushed into `members` - the director
        // would then own its position, and it would start wandering to the lounge.
        const vendorsHere = new Set<string>();
        for (let index = 0; index < input.vendors.length; index += 1) {
          const vendor = input.vendors[index];
          if (vendor === undefined) continue;
          vendorsHere.add(vendor.id);

          let terminal = vendorAvatars.get(vendor.id);
          if (!terminal) {
            terminal = createVendorAvatar(vendor.id, vendor.label, {
              color: vendor.color ?? defaultVendorColor(index),
              operator: vendor.operator,
              engagements: vendor.engagements,
            });
            vendorAvatars.set(vendor.id, terminal);
            officeRoot.add(terminal.group);
          }

          const dock = here.vendorBayPosition(index);
          const yaw = here.vendorBayFacing();
          terminal.group.position.set(dock.x, dock.y, dock.z);
          terminal.group.rotation.y = yaw;
          terminal.setFacing(yaw);
          terminal.setStatus(vendor.status);
          terminal.setSelected(vendor.id === selectedVendorId);
        }

        for (const [id, terminal] of [...vendorAvatars.entries()]) {
          if (vendorsHere.has(id)) continue;
          terminal.dispose();
          vendorAvatars.delete(id);
        }

        // What the idle can do here: the walkable grid for this floor's shape,
        // and the places on it worth walking to.
        const floorEntry = floors.get(activeFloorId) ?? floors.values().next().value ?? null;
        const grid = ensureNav(activeFloorId, floorEntry);
        if (grid) {
          for (const member of members) {
            const snapped = grid.resolve(member.home.x, member.home.z);
            const region = snapped ? grid.regionAt(snapped.x, snapped.z) : -1;
            if (region >= 0) regions.add(region);
          }
        }
        lastMembers = members;
        lastSpots = grid ? spotsFor(here, grid, regions) : [];
        applyLiveliness();

        // Frame a selection that was made before its avatar existed.
        if (pendingFocus && selectedId) {
          const motion = liveliness.motionFor(selectedId);
          const target = avatars.get(selectedId);
          if (target) {
            const point = motion ? new THREE.Vector3(motion.x, motion.y, motion.z) : target.group.position.clone();
            focusTarget = { point, distance: FOCUS_DISTANCE };
            pendingFocus = false;
          }
        }

        return parkedIds;
      },
      setSelected(employeeId) {
        selectedId = employeeId;
        pendingFocus = employeeId !== null;
        for (const [id, avatar] of avatars) avatar.setSelected(id === employeeId);
        const target = employeeId ? avatars.get(employeeId) : null;
        if (target) {
          focusTarget = { point: target.group.position.clone(), distance: FOCUS_DISTANCE };
          pendingFocus = false;
        }
      },
      /**
       * The vendor equivalent.
       *
       * A separate method rather than a tagged single call, because the two
       * selections live in separate maps and the store keeps them mutually
       * exclusive: when a vendor is selected `selection.employeeId` is already
       * null, so `setSelected(null)` has cleared every employee ring by the time
       * this runs.
       */
      setSelectedVendor(vendorId) {
        selectedVendorId = vendorId;
        pendingFocus = vendorId !== null;
        for (const [id, terminal] of vendorAvatars) terminal.setSelected(id === vendorId);
        const target = vendorId ? vendorAvatars.get(vendorId) : null;
        if (target) {
          // A terminal is short, so framing it wants a lower eye line and a
          // closer stop than a person: aiming at a standing head height would
          // leave it sitting in the bottom third of the frame.
          const point = target.group.position.clone();
          point.y += VENDOR_FOCUS_HEIGHT;
          focusTarget = { point, distance: VENDOR_FOCUS_DISTANCE };
          pendingFocus = false;
        }
      },
      setReducedMotion(next) {
        reduced = next;
        applyLiveliness();
      },
      setLiveliness(enabled) {
        livelinessWanted = enabled;
        applyLiveliness();
      },
      resetView() {
        focusTarget = null;
        controls.target.set(0, 1.1, 0);
        camera.position.set(10.5, 11.5, 15.5);
        controls.update();
      },
      dispose() {
        liveliness.reset();
        for (const avatar of avatars.values()) avatar.dispose();
        avatars.clear();
        for (const terminal of vendorAvatars.values()) terminal.dispose();
        vendorAvatars.clear();
      },
    };
    apiRef.current = api;

    // ---------------------------------------------------------------- loading
    const loader = new GLTFLoader();

    /**
     * The block kit, loaded alongside the office.
     *
     * A floor with no grown modules does not need it, so a missing or failed kit
     * is survivable: the office renders, and only the rooms it has not built are
     * absent. That is a better failure than a blank viewport.
     */
    loader.load(
      KIT_URL,
      (gltf) => {
        if (disposed) {
          disposeObject3D(gltf.scene);
          return;
        }
        // Keyed by both the node name (`Kit_pod4`) and the module id (`pod4`), so
        // a placement can look itself up without knowing how the kit was named.
        for (const child of [...gltf.scene.children]) {
          kit.set(child.name, child);
          const bare = child.name.replace(/^Kit_/, '');
          if (bare !== child.name) kit.set(bare, child);
        }
        setKitReady(true);
      },
      undefined,
      () => {
        if (!disposed) setKitReady(true);
      },
    );

    loader.load(
      OFFICE_URL,
      (gltf) => {
        if (disposed) {
          disposeObject3D(gltf.scene);
          return;
        }
        gltf.scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
        // The loaded model is the template: each organisation gets a clone on its
        // own floor, and the template itself is never added to the scene.
        template = gltf.scene;
        setPhase({ kind: 'ready' });

        // syncScene builds the floors and announces them, so it does not matter
        // whether the building arrived before the model or after it.
        setParked(
          api.syncScene({
            employees: employeesRef,
            roles: rolesRef,
            workspaces: workspacesRef,
            activeWorkspaceId: activeWorkspaceRef,
            selectedId,
            vendors: vendorsRef,
            selectedVendorId,
          }),
        );
      },
      (event) => {
        if (disposed) return;
        const total = event.total > 0 ? event.total : 0;
        const progress = total > 0 ? Math.min(1, event.loaded / total) : 0;
        setPhase({ kind: 'loading', progress });
      },
      (error) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setPhase({ kind: 'error', message: `could not load ${OFFICE_URL} — ${message}` });
      },
    );

    // ------------------------------------------------------------------ loop
    const tick = (): void => {
      if (disposed) return;
      frame = requestAnimationFrame(tick);
      const dt = Math.min(0.1, clock.getDelta());
      const elapsed = clock.elapsedTime;

      liveliness.update(dt, statusOf);

      // Somebody selected while they are walking is worth following: the camera
      // eases to where they actually are, not to where they were when clicked.
      if (focusTarget && selectedId) {
        const motion = liveliness.motionFor(selectedId);
        if (motion && motion.mode === 'walking') focusTarget.point.set(motion.x, motion.y, motion.z);
      }

      if (focusTarget) {
        const desired = focusTarget.point.clone().add(new THREE.Vector3(0, 0.95, 0));
        const k = 1 - Math.exp(-5 * dt);
        controls.target.lerp(desired, k);
        const offset = camera.position.clone().sub(controls.target);
        const distance = offset.length();
        if (distance > 0.0001) {
          // Keep the user's orbit angle and ease the distance to whatever this
          // framing wants: close for a person, wide for a whole floor.
          offset.setLength(distance + (focusTarget.distance - distance) * k);
          camera.position.copy(controls.target).add(offset);
        }
        if (controls.target.distanceTo(desired) < 0.03) focusTarget = null;
      }

      for (const avatar of avatars.values()) avatar.update(dt, elapsed, reduced, liveliness.motionFor(avatar.id));
      // Vendors are updated without a motion: a terminal is not in the director's
      // roster, so it has no `LivelinessMotion` and holds the dock position the
      // sync gave it.
      for (const terminal of vendorAvatars.values()) terminal.update(dt, elapsed, reduced, null);
      controls.update();
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', resize);
      canvasElement.removeEventListener('pointerdown', onPointerDown);
      canvasElement.removeEventListener('pointerup', onPointerUp);
      canvasElement.removeEventListener('pointermove', onPointerMove);
      canvasElement.removeEventListener('pointerleave', onPointerLeave);
      (canvasElement as EventTarget).removeEventListener('webglcontextlost', onContextLost);
      api.dispose();
      controls.dispose();
      // Floors own their plates and every avatar owns its geometry, so each is
      // released before the blanket sweep of the scene graph.
      for (const floor of floors.values()) disposeFloor(floor);
      floors.clear();
      disposeObject3D(scene);
      groundGeometry.dispose();
      groundMaterial.dispose();
      groundGridMesh.geometry.dispose();
      (groundGridMesh.material as THREE.Material).dispose();
      renderer.dispose();
      if (canvasElement.parentNode === host) host.removeChild(canvasElement);
      apiRef.current = null;
    };
    // The scene is created exactly once; data flows in through the ref API and
    // the small sync effects below. A reduced-motion change must not rebuild it.
  }, [store]);

  // Keep the scene in step with the office without touching the renderer.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    setParked(
      api.syncScene({
        employees: employees ?? [],
        roles: roles ?? [],
        workspaces: office?.workspaces ?? [],
        activeWorkspaceId: office?.activeWorkspaceId ?? '',
        selectedId: selection.employeeId,
        vendors: vendors ?? [],
        selectedVendorId: selection.vendorId,
      }),
    );
  }, [
    employees,
    roles,
    vendors,
    office?.workspaces,
    office?.activeWorkspaceId,
    selection.employeeId,
    selection.vendorId,
    phase.kind,
    kitReady,
  ]);

  useEffect(() => {
    apiRef.current?.setSelected(selection.employeeId);
  }, [selection.employeeId]);

  useEffect(() => {
    apiRef.current?.setSelectedVendor(selection.vendorId);
  }, [selection.vendorId]);

  useEffect(() => {
    apiRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    apiRef.current?.setLiveliness(livelinessOn);
  }, [livelinessOn]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const employee of employees ?? []) counts[employee.status] = (counts[employee.status] ?? 0) + 1;
    return counts;
  }, [employees]);

  const selected = useMemo(
    () => (employees ?? []).find((employee) => employee.id === selection.employeeId) ?? null,
    [employees, selection.employeeId],
  );

  const selectedVendor = useMemo(
    () => (vendors ?? []).find((vendor) => vendor.id === selection.vendorId) ?? null,
    [vendors, selection.vendorId],
  );

  /** How many terminals the bay is holding, for the dock line. */
  const vendorCount = vendors?.length ?? 0;

  /**
   * Where the bay is, derived from the floor's own layout rather than from the
   * scene.
   *
   * `anchors.ts` prefers a grown rack room and falls back to reception, and the
   * server already records exactly which modules a floor has grown - so the two
   * agree by construction instead of by the HUD asking the renderer. Asking the
   * scene would also leave the label blank until the GLB finished loading, which
   * is precisely when an operator is most likely to be looking for it.
   */
  const bayLabel = useMemo(
    () =>
      (office?.floor.layout.blocks ?? []).some((block) => block.kind === 'server4')
        ? 'the server room'
        : 'reception',
    [office?.floor.layout.blocks],
  );

  /** The floor on screen, so the viewport names the organisation it is showing. */
  const activeFloor = useMemo(
    () => office?.workspaces.find((workspace) => workspace.id === office.activeWorkspaceId) ?? null,
    [office],
  );

  const parkedNames = useMemo(() => {
    const byId = new Map((employees ?? []).map((employee) => [employee.id, employee.displayName]));
    return parked.map((id) => byId.get(id) ?? id);
  }, [parked, employees]);

  const handleReset = useCallback(() => apiRef.current?.resetView(), []);
  const handleClearSelection = useCallback(() => store.selectEmployee(null), [store]);
  const handleClearVendorSelection = useCallback(() => store.selectVendor(null), [store]);

  return (
    <div className="office-shell">
      <div className="office-viewport" ref={hostRef}>
        {phase.kind === 'loading' && (
          <div className="office-overlay office-overlay-center">
            <div className="spinner" aria-hidden="true" />
            <div className="office-overlay-title">Loading the office model</div>
            <div className="office-overlay-sub mono">
              {phase.progress > 0 ? `${Math.round(phase.progress * 100)}% · ${OFFICE_URL}` : OFFICE_URL}
            </div>
            <div className="meter">
              <div className="meter-fill" style={{ width: `${Math.max(4, Math.round(phase.progress * 100))}%` }} />
            </div>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="office-overlay office-overlay-center">
            <div className="office-overlay-title danger">The 3D office could not start</div>
            <div className="office-overlay-sub">{phase.message}</div>
            <div className="office-overlay-sub dim">
              The console still works: transcripts, approvals and telemetry all read the wire protocol.
            </div>
          </div>
        )}

        <div className="office-hud office-hud-top">
          <span className="hud-chip mono">{summary}</span>
          <span className="hud-spacer" />
          {activeFloor && (
            <span className="hud-chip" title={activeFloor.path}>
              <span className="floor-tag mono">F{activeFloor.floor}</span> {activeFloor.name}
            </span>
          )}
          <StylePanel />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setLivelinessWanted(livelinessOn ? 'off' : 'on')}
            disabled={reducedMotion}
            aria-pressed={livelinessActive}
            title={
              reducedMotion
                ? 'Your system asks for reduced motion, so the office stays still'
                : livelinessActive
                  ? 'Idle employees are up and about — switch off for a still office'
                  : 'Idle employees stay at their desks'
            }
          >
            Liveliness {livelinessActive ? 'on' : 'off'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleReset}>
            Reset view
          </button>
        </div>

        {selected && (
          <div className="office-hud office-hud-selected">
            <span className="dot" style={{ background: STATUS_COLOR[selected.status] }} aria-hidden="true" />
            <span className="strong">{selected.displayName}</span>
            <span className="dim">{selected.title}</span>
            <span className={`status status-${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
            <span className="mono dim">
              {selected.seatId ?? 'hot-desking'} · {roomLabel(selected.roomId)}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleClearSelection}>
              Clear
            </button>
          </div>
        )}

        {/*
          The selected vendor's HUD, and a different shape from an employee's on
          purpose: no title, no seat, no room to hot-desk in. Instead the vendor's
          operator, what it is doing, and - always - whether the read-only promise
          is *enforced* or merely *asked for*. That last one is the single fact an
          operator needs when looking at a machine that is editing their project
          directory on somebody else's behalf.
        */}
        {selectedVendor && (
          <div className="office-hud office-hud-selected">
            <span
              className="dot"
              style={{ background: VENDOR_STATUS_COLOR[selectedVendor.status] }}
              aria-hidden="true"
            />
            <span className="strong">{selectedVendor.label}</span>
            <span className="dim">{selectedVendor.operator}</span>
            <span className={`status status-${selectedVendor.status}`}>
              {VENDOR_STATUS_LABEL[selectedVendor.status]}
            </span>
            <span className="mono dim">
              {selectedVendor.capabilities.readOnlyEnforcement === 'sandbox'
                ? 'read-only, sandboxed'
                : selectedVendor.capabilities.readOnlyEnforcement === 'client'
                  ? 'read-only, mediated'
                  : 'read-only, requested'}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleClearVendorSelection}>
              Clear
            </button>
          </div>
        )}

        {/*
          Where the bay is, and only while something is docked in it. Shown as
          its own line because the answer changes with the building: a floor that
          grew a rack room docks them there, one that did not leaves them in
          reception, and an operator looking for Codex deserves to be told which.
        */}
        {vendorCount > 0 && (
          <div className="office-hud office-hud-warn" role="status">
            <span className="dot" style={{ background: VENDOR_STATUS_COLOR.docked }} aria-hidden="true" />
            <span>
              <span className="strong">{vendorCount}</span> third-party vendor{vendorCount === 1 ? '' : 's'} docked in{' '}
              {bayLabel}
            </span>
            <span className="mono dim">{vendors?.map((vendor) => vendor.label).join(', ') ?? ''}</span>
          </div>
        )}

        {parkedNames.length > 0 && (
          <div className="office-hud office-hud-warn" role="status">
            <span className="dot" style={{ background: '#fbbf24' }} aria-hidden="true" />
            <span>
              <span className="strong">{parkedNames.length}</span> hot-desking (no seat anchor) — parked at the bench
              near the dev floor
            </span>
            <span className="mono dim">{parkedNames.join(', ')}</span>
          </div>
        )}

        {office === null && (
          <div className="office-hud office-hud-bottom" role="status">
            <span className="dot pulse" style={{ background: '#fbbf24' }} aria-hidden="true" />
            <span>waiting for the orchestrator to send its first state…</span>
          </div>
        )}

        {office !== null && employees !== null && employees.length === 0 && (
          <div className="office-hud office-hud-bottom" role="status">
            <span>The org chart is empty — hire someone in the People panel.</span>
          </div>
        )}

        <div className="office-legend">
          {STATUS_ORDER.map((status) => (
            <span className="legend-item" key={status}>
              <span className="dot" style={{ background: STATUS_COLOR[status] }} aria-hidden="true" />
              {STATUS_LABEL[status]}
              <span className="mono dim">{statusCounts[status] ?? 0}</span>
            </span>
          ))}
        </div>

        <div className="office-hint dim">drag to orbit · scroll to zoom · click an employee to select</div>
      </div>
    </div>
  );
}
