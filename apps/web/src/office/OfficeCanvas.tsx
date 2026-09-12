/**
 * The 3D office.
 *
 * Plain imperative three.js, driven by one `requestAnimationFrame` loop:
 *
 *   renderer + perspective camera + OrbitControls
 *   lights (key with shadows, hemisphere fill, a warm bounce and a cool rim)
 *   office.glb loaded once, anchors indexed by node name
 *   one procedural avatar per employee, placed by looking its seat up
 *
 * React never re-creates the scene: the mount effect runs once, and data
 * changes are pushed into the live scene through a small imperative API kept in
 * a ref. That is what keeps the office usable while runs stream - no remounts,
 * no WebGL context churn.
 *
 * The view never crashes on missing data: an unknown seat parks the employee on
 * the bench row (and says so in the overlay), an employee with a null seat is
 * parked the same way, and a failed model load shows a real error state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { EmployeeState, Role, RoleAppearance, WorkspaceSummary } from '@dev3d/core';

import { usePrefersReducedMotion } from '../app/hooks';
import { useOffice, useSelection, useStore } from '../app/StoreContext';
import { FALLBACK_APPEARANCE } from '../app/store';
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from '../app/status';
import { indexAnchors, roomLabel } from './anchors';
  import { floorOffset, floorVisibility, resolveFloorId } from './floors';
import type { AnchorStats, OfficeAnchors } from './anchors';
import { createAvatar } from './avatar';
import type { Avatar } from './avatar';

const OFFICE_URL = `${import.meta.env.BASE_URL}office/office.glb`;
const KIT_URL = `${import.meta.env.BASE_URL}office/blocks.glb`;
/** Camera distance when framing one employee. */
const FOCUS_DISTANCE = 6.4;
/** Camera distance when framing a whole floor: the office is 22 x 16 m. */
const FLOOR_DISTANCE = 26;


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
}

interface SceneApi {
  /**
   * Brings the scene in step with the office: builds or removes floors, shows
   * the active one, re-seats avatars and refreshes statuses.
   */
  syncScene(input: SceneSync): string[];
  setSelected(employeeId: string | null): void;
  setReducedMotion(reduced: boolean): void;
  resetView(): void;
  dispose(): void;
}

function appearanceFor(role: Role | undefined): RoleAppearance {
  return role?.appearance ?? FALLBACK_APPEARANCE;
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

  // ------------------------------------------------------------------ the scene
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frame = 0;
    let focusTarget: { point: THREE.Vector3; distance: number } | null = null;
    let selectedId: string | null = null;
    let pendingFocus = false;
    let reduced = reducedMotion;
    const avatars = new Map<string, Avatar>();
    /** Latest props, so a sync requested before the model loads is not lost. */
    const employeesRef: EmployeeState[] = [];
    const workspacesRef: WorkspaceSummary[] = [];
    let activeWorkspaceRef = '';
    const rolesRef: Role[] = [];

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
      /** The plate size currently built, so it is only rebuilt when it changes. */
      slabSize: string;
      /**
       * Where to look when this floor is selected: the centre of what it has
       * become, and a distance that fits it in the viewport.
       */
      focus: { x: number; z: number; distance: number };
    }

    const floors = new Map<string, Floor>();
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
     * Instantiate the modules a floor has grown.
     *
     * Each cloned node is renamed to its namespaced seat id, which is what makes
     * two pods distinguishable: without it both would offer `Seat_POD4_02` and the
     * anchor index would keep whichever loaded first.
     */
    function buildModules(workspace: WorkspaceSummary): THREE.Group {
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
     * What a floor really owns is its coloured plate: that geometry and those two
     * materials are created for it and for nothing else.
     */
    function disposeFloor(entry: Floor): void {
      entry.slab.geometry.dispose();
      entry.edges.geometry.dispose();
      (entry.slab.material as THREE.Material).dispose();
      (entry.edges.material as THREE.Material).dispose();
      floorsRoot.remove(entry.group);
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
        if (existing) {
          const color = new THREE.Color(workspace.color ?? '#a78bfa');
          (existing.slab.material as THREE.MeshBasicMaterial).color.copy(color);
          (existing.edges.material as THREE.LineBasicMaterial).color.copy(color);
          // A floor that grew (or lost) a room is rebuilt in place: the core clone
          // is left alone and only the modules are replaced, because re-cloning
          // 312 meshes to add one pod would stutter the view.
          if (existing.layoutKey !== key) {
            // Detach only: a module instance shares its geometry and materials
            // with the kit template, so disposing here would release buffers the
            // other floors and the next clone are still using.
            existing.group.remove(existing.modules);
            existing.modules = buildModules(workspace);
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
        group.add(clone);

        const modules = buildModules(workspace);
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
          slabSize: '',
          focus: { x: 0, z: 0, distance: FLOOR_DISTANCE },
        };
        floors.set(workspace.id, entry);
        applySlabScale(entry);
      }
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
      // The lights are directional, so they have to climb with the building or
      // an upper floor ends up lit from underneath.
      keyLight.position.y = 16 + entry.offset;
      fillLight.position.y = 8 + entry.offset;
      rimLight.position.y = 6 + entry.offset;
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

    const pickAt = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const targets: THREE.Object3D[] = [];
      for (const avatar of avatars.values()) targets.push(avatar.group);
      const hits = raycaster.intersectObjects(targets, true);
      const first = hits[0];
      return first ? findAvatarId(first.object) : null;
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
      store.selectEmployee(pickAt(event.clientX, event.clientY));
    };

    const onPointerMove = (event: PointerEvent): void => {
      const id = pickAt(event.clientX, event.clientY);
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
        rolesRef.length = 0;
        rolesRef.push(...input.roles);
        workspacesRef.length = 0;
        workspacesRef.push(...input.workspaces);
        activeWorkspaceRef = input.activeWorkspaceId;
        selectedId = input.selectedId;

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
        let benchIndex = 0;

        for (const employee of input.employees) {
          present.add(employee.id);
          const role = roleById.get(employee.roleId);
          let avatar = avatars.get(employee.id);
          const created = avatar === undefined;
          if (!avatar) {
            avatar = createAvatar(employee.id, employee.displayName, appearanceFor(role));
            avatars.set(employee.id, avatar);
            officeRoot.add(avatar.group);
          }

          const seatName = employee.seatId ?? role?.seatId ?? null;
          const seatPosition = seatName ? here.seatPosition(seatName) : null;
          if (seatPosition && seatName) {
            avatar.group.position.set(seatPosition.x, seatPosition.y, seatPosition.z);
            const yaw = here.seatFacing(seatName, employee.roomId ?? role?.roomId ?? null);
            if (created) avatar.group.rotation.y = yaw;
            avatar.setFacing(yaw);
          } else {
            const bench = here.hotDeskPosition(benchIndex);
            benchIndex += 1;
            avatar.group.position.copy(bench);
            if (created) avatar.group.rotation.y = 0;
            avatar.setFacing(0);
            parkedIds.push(employee.id);
          }

          avatar.setStatus(employee.status);
          avatar.setSelected(employee.id === selectedId);
        }

        for (const [id, avatar] of [...avatars.entries()]) {
          if (present.has(id)) continue;
          avatar.dispose();
          avatars.delete(id);
        }

        // Frame a selection that was made before its avatar existed.
        if (pendingFocus && selectedId) {
          const target = avatars.get(selectedId);
          if (target) {
            focusTarget = { point: target.group.position.clone(), distance: FOCUS_DISTANCE };
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
      setReducedMotion(next) {
        reduced = next;
      },
      resetView() {
        focusTarget = null;
        controls.target.set(0, 1.1, 0);
        camera.position.set(10.5, 11.5, 15.5);
        controls.update();
      },
      dispose() {
        for (const avatar of avatars.values()) avatar.dispose();
        avatars.clear();
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

      for (const avatar of avatars.values()) avatar.update(dt, elapsed, reduced);
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
      }),
    );
  }, [employees, roles, office?.workspaces, office?.activeWorkspaceId, selection.employeeId, phase.kind, kitReady]);

  useEffect(() => {
    apiRef.current?.setSelected(selection.employeeId);
  }, [selection.employeeId]);

  useEffect(() => {
    apiRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const employee of employees ?? []) counts[employee.status] = (counts[employee.status] ?? 0) + 1;
    return counts;
  }, [employees]);

  const selected = useMemo(
    () => (employees ?? []).find((employee) => employee.id === selection.employeeId) ?? null,
    [employees, selection.employeeId],
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
