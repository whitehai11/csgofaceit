"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

type Props = {
  weaponName: string;
  skinName: string;
  skinImageUrl: string | null;
};

function normalizeWeapon(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function buildWeaponMesh(weaponName: string, material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const weapon = normalizeWeapon(weaponName);

  const addPart = (geometry: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    group.add(mesh);
  };

  if (["knife", "knifekarambit", "knife_karambit"].includes(weapon)) {
    addPart(new THREE.TorusGeometry(0.28, 0.05, 20, 80, Math.PI * 1.2), -0.25, -0.05, 0, 0, 0, Math.PI / 2);
    addPart(new THREE.BoxGeometry(0.75, 0.05, 0.08), 0.2, 0.02, 0, 0, 0, -0.2);
  } else if (["awp", "ssg08", "scar20", "g3sg1"].includes(weapon)) {
    addPart(new THREE.BoxGeometry(1.6, 0.12, 0.12), 0, 0, 0);
    addPart(new THREE.CylinderGeometry(0.04, 0.04, 1.3, 20), 0.5, 0.13, 0, 0, 0, Math.PI / 2);
    addPart(new THREE.BoxGeometry(0.5, 0.15, 0.12), -0.5, -0.1, 0);
    addPart(new THREE.CylinderGeometry(0.06, 0.06, 0.45, 24), -0.15, 0.2, 0, 0, 0, Math.PI / 2);
  } else if (["glock", "usp", "deagle", "p250", "fiveseven", "cz75", "tec9", "dualberettas"].includes(weapon)) {
    addPart(new THREE.BoxGeometry(0.8, 0.16, 0.16), 0, 0.06, 0);
    addPart(new THREE.BoxGeometry(0.3, 0.35, 0.16), -0.2, -0.17, 0, 0, 0, -0.2);
  } else {
    addPart(new THREE.BoxGeometry(1.5, 0.16, 0.14), 0, 0, 0);
    addPart(new THREE.BoxGeometry(0.5, 0.15, 0.14), -0.5, -0.15, 0, 0, 0, -0.15);
    addPart(new THREE.CylinderGeometry(0.045, 0.045, 0.9, 20), 0.5, 0.11, 0, 0, 0, Math.PI / 2);
    addPart(new THREE.BoxGeometry(0.3, 0.18, 0.1), -0.05, -0.18, 0, 0.2, 0, 0);
  }

  return group;
}

export function Skin3DPreview({ weaponName, skinName, skinImageUrl }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [inspectRunning, setInspectRunning] = useState(false);

  const fallbackLabel = useMemo(() => {
    return `${weaponName} • ${skinName}`;
  }, [weaponName, skinName]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(root.clientWidth, root.clientHeight);
    root.innerHTML = "";
    root.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(50, root.clientWidth / root.clientHeight, 0.1, 100);
    camera.position.set(0, 0.2, 3.2);

    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(3, 3, 4);
    const rim = new THREE.DirectionalLight(0x5865f2, 0.8);
    rim.position.set(-3, -2, -3);
    scene.add(ambient, key, rim);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 60),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.95, metalness: 0.05, transparent: true, opacity: 0.55 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.65;
    scene.add(floor);

    const loader = new THREE.TextureLoader();
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.35,
      metalness: 0.5
    });

    if (skinImageUrl) {
      loader.load(
        skinImageUrl,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(1.8, 1.2);
          material.map = texture;
          material.needsUpdate = true;
        },
        undefined,
        () => {
          // ignore image errors, keep plain material
        }
      );
    }

    const weapon = buildWeaponMesh(weaponName, material);
    weapon.rotation.y = -0.6;
    scene.add(weapon);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      weapon.rotation.y += dx * 0.01;
      weapon.rotation.x += dy * 0.006;
      weapon.rotation.x = Math.max(-0.65, Math.min(0.65, weapon.rotation.x));
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const onPointerUp = () => {
      dragging = false;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = Math.max(1.7, Math.min(6, camera.position.z + event.deltaY * 0.004));
      camera.position.z = next;
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    let raf = 0;
    let inspectStart = 0;
    const render = (timestamp: number) => {
      if (inspectRunning) {
        if (!inspectStart) inspectStart = timestamp;
        const elapsed = (timestamp - inspectStart) / 1000;
        weapon.rotation.y += 0.06;
        weapon.position.z = Math.sin(elapsed * 6) * 0.16;
        if (elapsed > 1.6) {
          inspectStart = 0;
          setInspectRunning(false);
          weapon.position.z = 0;
        }
      } else {
        weapon.rotation.y += 0.0035;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    const onResize = () => {
      const width = root.clientWidth;
      const height = root.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.dispose();
      scene.clear();
      root.innerHTML = "";
    };
  }, [weaponName, skinImageUrl, inspectRunning]);

  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold">3D Preview</p>
        <button type="button" className="btn-secondary" onClick={() => setInspectRunning(true)}>
          Inspect
        </button>
      </div>
      <div ref={rootRef} className="h-64 w-full cursor-grab overflow-hidden rounded-lg bg-gradient-to-br from-[#0c1220] to-[#111827]" />
      <p className="mt-2 text-xs text-white/65">Rotate: drag • Zoom: mouse wheel • {fallbackLabel}</p>
    </div>
  );
}
