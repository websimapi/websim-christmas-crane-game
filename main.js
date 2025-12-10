import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import nipplejs from 'nipplejs';
import { DataManager } from './db.js';

// --- Game Constants ---
const WORLD_SCALE = 1;
const CRANE_SPEED = 4;
const CRANE_LIMITS = { x: 3.5, z: 3.5 };
const DROP_SPEED = 3;
const CLAW_FORCE = 150;

// --- State ---
const state = {
    isPlaying: false,
    craneMode: 'IDLE', // IDLE, MOVING, DROPPING, GRABBING, RAISING, RETURNING, RELEASING
    input: { x: 0, y: 0, drop: false },
    prizes: [],
    wonPrizes: []
};

// --- Setup Systems ---
const db = new DataManager();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true });
const world = new CANNON.World();

// Physics Materials
const slipperyMat = new CANNON.Material('slippery');
const gripperMat = new CANNON.Material('gripper');
const prizeMat = new CANNON.Material('prize');

// Contact Materials
const prizeToPrize = new CANNON.ContactMaterial(prizeMat, prizeMat, { friction: 0.3, restitution: 0.1 });
const gripperToPrize = new CANNON.ContactMaterial(gripperMat, prizeMat, { friction: 0.9, restitution: 0 }); // High friction to grab
const slipperyContact = new CANNON.ContactMaterial(slipperyMat, prizeMat, { friction: 0.0, restitution: 0.1 });

world.addContactMaterial(prizeToPrize);
world.addContactMaterial(gripperToPrize);
world.addContactMaterial(slipperyContact);

world.gravity.set(0, -9.82, 0);

// --- 3D Objects References ---
let craneBase, clawGroup, fingers = [];
let physicsBodies = [];
let clawConstraint = null; // The physical constraint when holding logic is active (optional)
let craneBody, fingerBodies = [];

async function init() {
    // 1. UI Setup
    setupUI();
    
    // 2. 3D Setup & Rendering (Start immediately so user sees something)
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.getElementById('game-container').appendChild(renderer.domElement);

    camera.position.set(0, 8, 12);
    camera.lookAt(0, 2, 0);

    // Lighting
    const ambLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambLight);

    const dirLight = new THREE.DirectionalLight(0xfffaed, 1);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    dirLight.shadow.camera.left = -10;
    dirLight.shadow.camera.right = 10;
    dirLight.shadow.camera.top = 10;
    dirLight.shadow.camera.bottom = -10;
    scene.add(dirLight);

    // Environment (The Machine)
    buildMachine();

    // The Claw
    buildClaw();

    // Prizes
    spawnPrizes();

    // Resize Handler
    window.addEventListener('resize', onWindowResize);

    // Start Loop
    animate();

    // 3. DB Init (Async)
    updateStatus("Connecting to Santa's Workshop...");
    try {
        await db.init();
        checkCooldown();
        setInterval(checkCooldown, 1000); // Update timer
    } catch (e) {
        console.error("DB Init Failed:", e);
        updateStatus("Connection Failed. Refresh to try again.");
    }
}

function buildMachine() {
    // Floor
    const floorGeo = new THREE.BoxGeometry(10, 1, 10);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xaa2222, roughness: 0.8 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -0.5;
    floor.receiveShadow = true;
    scene.add(floor);

    const floorBody = new CANNON.Body({ mass: 0, material: slipperyMat }); // Static
    floorBody.addShape(new CANNON.Box(new CANNON.Vec3(5, 0.5, 5)));
    floorBody.position.set(0, -0.5, 0);
    world.addBody(floorBody);

    // Walls (Glass)
    const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff, transmission: 0.9, opacity: 0.3, transparent: true, roughness: 0, metalness: 0
    });
    
    const wallGeo = new THREE.BoxGeometry(10, 10, 0.2);
    const backWall = new THREE.Mesh(wallGeo, glassMat);
    backWall.position.set(0, 4.5, -5.1);
    scene.add(backWall);

    // Walls Physics
    const wallShape = new CANNON.Box(new CANNON.Vec3(5, 5, 0.1));
    const backBody = new CANNON.Body({ mass: 0 });
    backBody.addShape(wallShape);
    backBody.position.set(0, 4.5, -5.1);
    world.addBody(backBody);

    const leftBody = new CANNON.Body({ mass: 0 });
    leftBody.addShape(wallShape);
    leftBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2);
    leftBody.position.set(-5.1, 4.5, 0);
    world.addBody(leftBody);

    const rightBody = new CANNON.Body({ mass: 0 });
    rightBody.addShape(wallShape);
    rightBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2);
    rightBody.position.set(5.1, 4.5, 0);
    world.addBody(rightBody);

    const frontBody = new CANNON.Body({ mass: 0 });
    frontBody.addShape(wallShape);
    frontBody.position.set(0, 4.5, 5.1);
    world.addBody(frontBody);

    // Chute (Win zone)
    const chuteGeo = new THREE.BoxGeometry(2.5, 1, 2.5);
    const chuteMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const chute = new THREE.Mesh(chuteGeo, chuteMat);
    chute.position.set(-3.5, 0.1, 3.5);
    scene.add(chute);

    // Chute Sensor (Trigger)
    const chuteShape = new CANNON.Box(new CANNON.Vec3(1.25, 0.5, 1.25));
    const chuteBody = new CANNON.Body({ isTrigger: true });
    chuteBody.addShape(chuteShape);
    chuteBody.position.set(-3.5, 0.5, 3.5);
    world.addBody(chuteBody);

    chuteBody.addEventListener('collide', (e) => {
        if (state.craneMode !== 'RELEASING' && state.craneMode !== 'RETURNING' && state.craneMode !== 'IDLE') return;
        
        // Check if it's a prize
        const bodyB = e.body;
        if (bodyB.userData && bodyB.userData.isPrize && !bodyB.userData.hasWon) {
            bodyB.userData.hasWon = true;
            handleWin(bodyB.userData.name);
        }
    });
}

function buildClaw() {
    // Visual Group for the whole crane mechanism
    craneBase = new THREE.Group();
    craneBase.position.set(0, 6, 0);
    scene.add(craneBase);

    // The Rod
    const rodGeo = new THREE.CylinderGeometry(0.1, 0.1, 4);
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.2 });
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.position.y = 2; // Offset so 0 is bottom
    craneBase.add(rod);

    // The Claw Hub
    const hubGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4);
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const hub = new THREE.Mesh(hubGeo, hubMat);
    craneBase.add(hub);

    // Physics Body for Crane Hub (Kinematic - we move it manually)
    const hubShape = new CANNON.Cylinder(0.5, 0.5, 0.4, 8);
    craneBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, position: new CANNON.Vec3(0, 6, 0) });
    craneBody.addShape(hubShape);
    world.addBody(craneBody);

    // Fingers
    const fingerGeo = new THREE.BoxGeometry(0.2, 1.5, 0.2);
    const fingerMat = new THREE.MeshStandardMaterial({ color: 0x990000 });
    
    // Create 4 fingers
    for(let i=0; i<4; i++) {
        const finger = new THREE.Mesh(fingerGeo, fingerMat);
        // Visuals are tricky with physics articulation, we'll keep visuals simple and parented to hub
        // but animate their rotation
        finger.userData.angle = (Math.PI / 2) * i;
        hub.add(finger);
        fingers.push(finger);

        // Physics Fingers
        const fShape = new CANNON.Box(new CANNON.Vec3(0.1, 0.75, 0.1));
        const fBody = new CANNON.Body({ mass: 1, material: gripperMat });
        fBody.addShape(fShape);
        fBody.position.set(
            Math.sin(finger.userData.angle) * 0.6, 
            5.2, 
            Math.cos(finger.userData.angle) * 0.6
        );
        fBody.linearDamping = 0.5;
        fBody.angularDamping = 0.5;
        world.addBody(fBody);
        fingerBodies.push(fBody);

        // Connect finger to hub
        // We need a constraint that allows rotation (Hinge)
        const pivotA = new CANNON.Vec3(Math.sin(finger.userData.angle) * 0.4, -0.2, Math.cos(finger.userData.angle) * 0.4);
        const pivotB = new CANNON.Vec3(0, 0.75, 0); // Top of finger
        const axis = new CANNON.Vec3(Math.cos(finger.userData.angle), 0, -Math.sin(finger.userData.angle)); // Tangent to circle
        
        const constraint = new CANNON.HingeConstraint(craneBody, fBody, {
            pivotA: pivotA,
            axisA: axis,
            pivotB: pivotB,
            axisB: axis,
        });
        constraint.enableMotor(); // We will use motor to open/close
        constraint.setMotorSpeed(0);
        constraint.setMotorMaxForce(10);
        world.addConstraint(constraint);
        
        finger.userData.constraint = constraint;
        finger.userData.physicsBody = fBody;
    }
}

function spawnPrizes() {
    const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff];
    const types = ['box', 'sphere'];

    for (let i = 0; i < 20; i++) {
        const type = types[Math.floor(Math.random() * types.length)];
        const color = colors[Math.floor(Math.random() * colors.length)];
        
        let geo, shape, mesh;
        
        if (type === 'box') {
            const size = 0.8 + Math.random() * 0.4;
            geo = new THREE.BoxGeometry(size, size, size);
            shape = new CANNON.Box(new CANNON.Vec3(size/2, size/2, size/2));
            
            // Texture? Let's just use color + simple ribbon geometry simulation via texture
            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
            ctx.fillRect(0,0,64,64);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(28, 0, 8, 64);
            ctx.fillRect(0, 28, 64, 8);
            const tex = new THREE.CanvasTexture(canvas);
            tex.magFilter = THREE.NearestFilter;
            
            const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 });
            mesh = new THREE.Mesh(geo, mat);
        } else {
            const radius = 0.5 + Math.random() * 0.3;
            geo = new THREE.SphereGeometry(radius, 16, 16);
            shape = new CANNON.Sphere(radius);
            const mat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.1, metalness: 0.5 });
            mesh = new THREE.Mesh(geo, mat);
        }

        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);

        const body = new CANNON.Body({ mass: 0.5, material: prizeMat });
        body.addShape(shape);
        body.position.set(
            (Math.random() - 0.5) * 6,
            1 + Math.random() * 3,
            (Math.random() - 0.5) * 6
        );
        body.quaternion.setFromEuler(Math.random(), Math.random(), Math.random());
        body.linearDamping = 0.1;
        body.angularDamping = 0.1;
        
        // Add name for inventory
        body.userData = { 
            isPrize: true, 
            name: `${color.toString(16) === 'ff0000' ? 'Red' : 'Mystery'} ${type === 'box' ? 'Present' : 'Ornament'}`
        };

        world.addBody(body);
        state.prizes.push({ mesh, body });
    }
}

// --- Game Logic ---

function checkCooldown() {
    const statusEl = document.getElementById('status');
    const playBtn = document.getElementById('play-btn');
    const timerEl = document.getElementById('cooldown-timer');
    const timerVal = document.getElementById('timer-val');

    if (!db.userRecord) return; // Still loading

    if (db.canPlay()) {
        statusEl.innerText = "Ready to Play!";
        playBtn.innerText = "PLAY FREE";
        playBtn.disabled = false;
        timerEl.classList.add('hidden');
    } else {
        statusEl.innerText = "Come back tomorrow!";
        playBtn.innerText = "COOLDOWN";
        playBtn.disabled = true;
        timerEl.classList.remove('hidden');
        
        // Update timer text
        const ms = db.getTimeUntilNextPlay();
        const h = Math.floor(ms / (1000 * 60 * 60)).toString().padStart(2, '0');
        const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60)).toString().padStart(2, '0');
        const s = Math.floor((ms % (1000 * 60)) / 1000).toString().padStart(2, '0');
        timerVal.innerText = `${h}:${m}:${s}`;
    }
}

async function startGame() {
    const playBtn = document.getElementById('play-btn');
    if (playBtn.disabled) return;

    // Resume audio context on user interaction
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    } else if (!audioCtx) {
        // Initialize if not ready
        playSound('silence'); // Dummy call to init
    }

    if (!db.canPlay()) return;

    // UI Feedback - immediate
    playBtn.disabled = true;
    const originalText = playBtn.innerText;
    playBtn.innerText = "STARTING...";

    try {
        await db.useFreePlay();
    } catch (e) {
        console.error("Game Start Error:", e);
        alert("Could not start game. Please check your connection and try again.");
        playBtn.innerText = originalText;
        playBtn.disabled = false;
        checkCooldown();
        return;
    }

    checkCooldown(); // Update UI immediately (timer will appear)

    state.isPlaying = true;
    state.craneMode = 'MOVING';
    playBtn.classList.add('hidden');
    
    // Reset Crane Position
    craneBody.position.set(0, 6, 0);
    craneBody.velocity.set(0, 0, 0);
    openClaw();
}

function updateCraneLogic(dt) {
    if (!state.isPlaying) return;

    const cranePos = craneBody.position;

    switch (state.craneMode) {
        case 'MOVING':
            // Input movement
            craneBody.velocity.set(state.input.x * CRANE_SPEED, 0, state.input.y * CRANE_SPEED);
            
            // Bounds
            if (cranePos.x > CRANE_LIMITS.x) craneBody.position.x = CRANE_LIMITS.x;
            if (cranePos.x < -CRANE_LIMITS.x) craneBody.position.x = -CRANE_LIMITS.x;
            if (cranePos.z > CRANE_LIMITS.z) craneBody.position.z = CRANE_LIMITS.z;
            if (cranePos.z < -CRANE_LIMITS.z) craneBody.position.z = -CRANE_LIMITS.z;

            // Drop Trigger
            if (state.input.drop) {
                state.craneMode = 'DROPPING';
                craneBody.velocity.set(0, -DROP_SPEED, 0);
            }
            break;

        case 'DROPPING':
            craneBody.velocity.set(0, -DROP_SPEED, 0);
            // Stop at floor or object?
            // Simple logic: stop at y=1.5 (just above floor objects usually)
            if (cranePos.y <= 1.5) {
                state.craneMode = 'GRABBING';
                craneBody.velocity.set(0, 0, 0);
                closeClaw();
                setTimeout(() => {
                    state.craneMode = 'RAISING';
                }, 1500); // Wait for grip
            }
            break;

        case 'GRABBING':
            craneBody.velocity.set(0, 0, 0);
            break;

        case 'RAISING':
            craneBody.velocity.set(0, DROP_SPEED, 0);
            if (cranePos.y >= 6) {
                state.craneMode = 'RETURNING';
                craneBody.velocity.set(0,0,0);
            }
            break;

        case 'RETURNING':
            // Move towards Chute (-3.5, 6, 3.5)
            const targetX = -3.5;
            const targetZ = 3.5;
            
            const dx = targetX - cranePos.x;
            const dz = targetZ - cranePos.z;
            const dist = Math.sqrt(dx*dx + dz*dz);

            if (dist < 0.1) {
                state.craneMode = 'RELEASING';
                craneBody.velocity.set(0,0,0);
                openClaw();
                setTimeout(() => {
                    endGame();
                }, 2000);
            } else {
                const speed = 2;
                craneBody.velocity.set(
                    (dx / dist) * speed,
                    0,
                    (dz / dist) * speed
                );
            }
            break;
        
        case 'RELEASING':
            craneBody.velocity.set(0,0,0);
            break;
    }
}

function openClaw() {
    fingerBodies.forEach((body, i) => {
        const finger = fingers[i];
        finger.userData.constraint.setMotorSpeed(2); // Open
    });
}

function closeClaw() {
    fingerBodies.forEach((body, i) => {
        const finger = fingers[i];
        finger.userData.constraint.setMotorSpeed(-3); // Close tightly
    });
}

function endGame() {
    state.isPlaying = false;
    state.craneMode = 'IDLE';
    state.input.drop = false;
    
    // UI Reset handled by checkCooldown mostly, but we need to show play button again
    // if they have more plays (unlikely since limit is 1/day)
    document.getElementById('play-btn').classList.remove('hidden');
    checkCooldown();
}

async function handleWin(prizeName) {
    playSound('win');
    await db.addPrize(prizeName);
    
    document.getElementById('win-item-name').innerText = prizeName;
    document.getElementById('win-modal').classList.remove('hidden');
}

// --- UI & Input ---

function setupUI() {
    // Inventory
    document.getElementById('inventory-btn').addEventListener('click', () => {
        const list = document.getElementById('inventory-list');
        list.innerHTML = '';
        const inv = db.getInventory();
        if (inv.length === 0) list.innerHTML = '<div>No prizes yet! Play to win.</div>';
        
        inv.reverse().forEach(item => {
            const div = document.createElement('div');
            div.className = 'inventory-item';
            const date = new Date(item.won_at).toLocaleDateString();
            div.innerHTML = `<strong>${item.name}</strong><br><small>${date}</small>`;
            list.appendChild(div);
        });
        document.getElementById('inventory-modal').classList.remove('hidden');
    });

    document.getElementById('close-inventory').addEventListener('click', () => {
        document.getElementById('inventory-modal').classList.add('hidden');
    });

    document.getElementById('claim-prize').addEventListener('click', () => {
        document.getElementById('win-modal').classList.add('hidden');
    });

    // Play
    document.getElementById('play-btn').addEventListener('click', startGame);

    // Keyboard
    document.addEventListener('keydown', (e) => {
        if (!state.isPlaying || state.craneMode !== 'MOVING') return;
        switch(e.key.toLowerCase()) {
            case 'w': state.input.y = -1; break;
            case 's': state.input.y = 1; break;
            case 'a': state.input.x = -1; break;
            case 'd': state.input.x = 1; break;
            case ' ': state.input.drop = true; break;
        }
    });

    document.addEventListener('keyup', (e) => {
        switch(e.key.toLowerCase()) {
            case 'w': if(state.input.y === -1) state.input.y = 0; break;
            case 's': if(state.input.y === 1) state.input.y = 0; break;
            case 'a': if(state.input.x === -1) state.input.x = 0; break;
            case 'd': if(state.input.x === 1) state.input.x = 0; break;
        }
    });

    // Mobile
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
        document.getElementById('controls-hint').style.display = 'none';
        document.getElementById('joystick-zone').style.display = 'block';
        const dropBtn = document.getElementById('mobile-drop-btn');
        dropBtn.style.display = 'block';
        
        dropBtn.addEventListener('touchstart', (e) => {
            e.preventDefault(); 
            if(state.isPlaying && state.craneMode === 'MOVING') state.input.drop = true;
        });

        const manager = nipplejs.create({
            zone: document.getElementById('joystick-zone'),
            mode: 'static',
            position: { left: '50%', top: '50%' },
            color: 'white'
        });

        manager.on('move', (evt, data) => {
            if (!state.isPlaying) return;
            const force = Math.min(data.force, 1.0);
            const angle = data.angle.radian;
            // NippleJS angle: 0 is right, PI/2 is up.
            // ThreeJS X is right, Z is down (towards camera).
            // Input y needs to be negative for 'up' in 2d, which maps to negative Z in 3d
            
            state.input.x = Math.cos(angle) * force;
            state.input.y = -Math.sin(angle) * force; 
        });

        manager.on('end', () => {
            state.input.x = 0;
            state.input.y = 0;
        });
    }
}

function updateStatus(msg) {
    document.getElementById('status').innerText = msg;
}

// --- Main Loop ---

function animate() {
    requestAnimationFrame(animate);
    
    const dt = 1/60;
    
    // Physics Step
    world.step(dt);

    // Game Logic
    updateCraneLogic(dt);

    // Sync Graphics to Physics
    state.prizes.forEach(p => {
        p.mesh.position.copy(p.body.position);
        p.mesh.quaternion.copy(p.body.quaternion);
    });

    // Sync Crane Hub
    craneBase.position.copy(craneBody.position);
    
    // Sync Fingers
    fingerBodies.forEach((body, i) => {
        fingers[i].position.copy(body.position);
        // Transform world pos to local pos relative to hub for rendering hierarchy?
        // Actually, since fingers are children of hub in ThreeJS, we need to be careful.
        // It's easier to just set world position of mesh, but that breaks the hierarchy logic visually if we aren't careful.
        // Let's detach fingers from hub in ThreeJS and just add them to scene to match Physics directly.
        if (fingers[i].parent !== scene) {
            fingers[i].parent.remove(fingers[i]);
            scene.add(fingers[i]);
        }
        fingers[i].quaternion.copy(body.quaternion);
    });

    renderer.render(scene, camera);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Audio Helper
let audioCtx;
function playSound(type) {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    // Ensure context is running (browsers might suspend it)
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
    }

    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'win') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.2);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
    }
}

// Start the game initialization
init().catch(e => {
    console.error("Initialization failed:", e);
    document.getElementById('status').innerText = "Error loading game.";
});