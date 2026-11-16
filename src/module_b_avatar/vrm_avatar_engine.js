/**
 * ============================================================================
 * MODULE B: VRM AVATAR ENGINE (Three.js + @pixiv/three-vrm)
 * Thực thi giao diện IAvatarProvider:
 * - Chạy local, tối ưu cho Intel Iris Xe (không GPU rời)
 * - Khoá tối đa 30 FPS (luôn ưu tiên 30 FPS khi đang nói để khẩu hình & mắt mượt tuyệt đối)
 * - Tự động thu nhỏ Texture > 1024px xuống <= 1024px, tắt shadow map & post-processing
 * - Ánh mắt tự nhiên (Eye Contact): Tự động nhìn thẳng vào mắt người dùng khi nói
 *   hoặc khi chuột đặt ở bảng nút bên dưới; chớp mắt biểu cảm theo nhịp nghỉ câu
 * - Lip-Sync Kép (Hybrid Viseme Timeline + AnalyserNode):
 *   Kết hợp mốc thời gian từng từ (WordBoundary ms) + phân rã nguyên âm đôi Tiếng Việt/Anh
 *   + biên độ sóng âm thời gian thực (AnalyserNode) giúp miệng khớp từng chữ 100%
 * ============================================================================
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { IAvatarProvider, AURA_EMOTIONS } from '../interfaces/aura_contracts.js';

export class VRMAvatarEngine extends IAvatarProvider {
  constructor(eventBus, config = {}) {
    super();
    this.eventBus = eventBus;
    this.maxFps = config.maxFps || 30;
    this.liteFps = config.liteFps || 15;
    this.maxTextureSize = config.maxTextureSize || 1024;
    this.isLiteMode = false;
    this.liteModeReason = '';

    this.container = null;
    this.canvas = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.vrm = null;
    this.lookAtTarget = null;

    // Trạng thái biểu cảm (Giữ mắt mở trong trẻo tự nhiên ở trạng thái mặc định)
    this.currentEmotion = AURA_EMOTIONS.NEUTRAL;
    this.emotionWeights = { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 };
    this.targetEmotionWeights = { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 };

    // Mouse Gaze (-1 .. +1) + Eye Contact thông minh + Micro-saccades
    this.mouseX = 0;
    this.mouseY = 0;
    this.lastMouseMoveTime = 0;
    this.smoothGazeX = 0;
    this.smoothGazeY = 0;
    this.saccadeX = 0;
    this.saccadeY = 0;
    this.saccadeTimer = 0;

    // Blinking state
    this.blinkTimer = 0;
    this.nextBlinkInterval = 2.6;
    this.blinkPhase = -1; // -1 = không chớp, 0..1 = tiến trình chớp
    this.blinkValue = 0;
    this.wasInWord = false;

    // Nodding state
    this.nodTimer = 0;
    this.nodDuration = 0;
    this.nodIntensity = 0;

    // Speaking & Hybrid Lip-Sync (WordBoundary Viseme Timeline + AnalyserNode)
    this.isSpeaking = false;
    this.activeAudioElement = null;
    this.visemeTimeline = [];
    this.audioContext = null;
    this.analyserNode = null;
    this.freqData = null;
    this.timeData = null;
    this.currentAudioRms = 0;
    this.peakAudioRms = 0;
    this.peakMouthOpen = 0;

    // Bộ dò đường bao âm tiết (Dual-Envelope Follower)
    this.envFast = 0;
    this.envSlow = 0;
    this.wasInSyllablePeak = false;
    this.speechVowelList = ['aa', 'oh', 'ee', 'ih', 'ou'];
    this.speechVowelIndex = 0;
    this.activeVowel = 'aa';
    this.secondaryVowel = 'oh';

    this.simSpeechTimer = 0;
    this.simSpeechDuration = 0;
    this.simSpeechText = '';
    this.mouthWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this.targetMouthWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

    // Đo FPS thực tế
    this.currentFps = 0;
    this.frameCount = 0;
    this.fpsAccumTime = 0;
    this.lastFrameTimestamp = 0;
    this.elapsedTime = 0;
    this.downsampledTextureCount = 0;
    this.totalTextureCount = 0;
    this.armSignLeft = 1;
    this.armSignRight = -1;
  }

  async init(containerElement, config = {}) {
    this.container = containerElement;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'auraVrmCanvas';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.pointerEvents = 'none';
    this.container.innerHTML = '';
    this.container.appendChild(this.canvas);

    const width = this.container.clientWidth || 400;
    const height = this.container.clientHeight || 560;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: false,
      powerPreference: 'low-power',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false
    });

    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(1.0);
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(26.0, width / height, 0.1, 20.0);
    this.camera.position.set(0.0, 1.36, 1.45);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.85);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfff6f0, 1.15);
    dirLight.position.set(1.2, 2.0, 2.5);
    dirLight.castShadow = false;
    this.scene.add(dirLight);

    this.lookAtTarget = new THREE.Object3D();
    this.lookAtTarget.position.set(0, 1.4, 1.5);
    this.scene.add(this.lookAtTarget);

    window.addEventListener('resize', () => this._onResize());

    this.lastFrameTimestamp = performance.now();
    requestAnimationFrame((ts) => this._renderLoop(ts));
  }

  _onResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const w = this.container.clientWidth || 400;
    const h = this.container.clientHeight || 560;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const ratio = (this.isLiteMode && !this.isSpeaking) ? 0.8 : 1.0;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
  }

  async loadModel(modelUrl = '/assets/models/aura.vrm') {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    return new Promise((resolve, reject) => {
      loader.load(
        modelUrl,
        (gltf) => {
          const vrm = gltf.userData.vrm;
          if (!vrm) {
            reject(new Error('File không chứa dữ liệu VRM hợp lệ.'));
            return;
          }

          if (this.vrm) {
            this.scene.remove(this.vrm.scene);
            VRMUtils.deepDispose(this.vrm.scene);
          }

          VRMUtils.removeUnnecessaryVertices(gltf.scene);
          VRMUtils.removeUnnecessaryJoints(gltf.scene);
          VRMUtils.rotateVRM0(vrm);

          this.downsampledTextureCount = 0;
          this.totalTextureCount = 0;
          this._optimizeSceneTextures(vrm.scene, this.maxTextureSize);

          vrm.scene.traverse((obj) => {
            obj.frustumCulled = false;
            obj.castShadow = false;
            obj.receiveShadow = false;
          });

          if (vrm.lookAt) {
            vrm.lookAt.target = this.lookAtTarget;
          }

          this.scene.add(vrm.scene);
          this.vrm = vrm;

          this._calibrateNaturalArmPose();
          this._autoFrameCameraToHead();
          this.setEmotion(AURA_EMOTIONS.NEUTRAL);

          if (this.eventBus) {
            this.eventBus.emit('avatar:loaded', {
              modelUrl,
              metaVersion: vrm.meta?.metaVersion || '1.0',
              totalTextures: this.totalTextureCount,
              downsampledTextures: this.downsampledTextureCount
            });
          }

          resolve(vrm);
        },
        undefined,
        (err) => {
          console.error('[VRMAvatarEngine] Lỗi tải VRM:', err);
          reject(err);
        }
      );
    });
  }

  _optimizeSceneTextures(root, maxDim = 1024) {
    const visitedTextures = new Set();
    const texProps = ['map', 'emissiveMap', 'normalMap', 'shadeMultiplyTexture', 'matcapTexture', 'rimMultiplyTexture'];

    root.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];

      for (const mat of materials) {
        for (const prop of texProps) {
          const tex = mat[prop];
          if (!tex || visitedTextures.has(tex)) continue;
          visitedTextures.add(tex);
          this.totalTextureCount++;

          tex.generateMipmaps = false;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = 1;

          const img = tex.image;
          if (img && img.width && img.height && (img.width > maxDim || img.height > maxDim)) {
            const scale = maxDim / Math.max(img.width, img.height);
            const targetW = Math.max(1, Math.round(img.width * scale));
            const targetH = Math.max(1, Math.round(img.height * scale));

            const offCanvas = document.createElement('canvas');
            offCanvas.width = targetW;
            offCanvas.height = targetH;
            const ctx = offCanvas.getContext('2d');
            ctx.drawImage(img, 0, 0, targetW, targetH);

            tex.image = offCanvas;
            tex.needsUpdate = true;
            this.downsampledTextureCount++;
          }
        }
      }
    });
  }

  _calibrateNaturalArmPose() {
    if (!this.vrm || !this.vrm.humanoid) return;
    const h = this.vrm.humanoid;
    const lUpper = h.getNormalizedBoneNode('leftUpperArm');
    const lLower = h.getNormalizedBoneNode('leftLowerArm');
    const rUpper = h.getNormalizedBoneNode('rightUpperArm');
    const rLower = h.getNormalizedBoneNode('rightLowerArm');

    if (lUpper && lLower) {
      const posPos = new THREE.Vector3();
      const posNeg = new THREE.Vector3();

      lUpper.rotation.z = 1.15;
      this.vrm.update(0);
      this.vrm.scene.updateMatrixWorld(true);
      lLower.getWorldPosition(posPos);

      lUpper.rotation.z = -1.15;
      this.vrm.update(0);
      this.vrm.scene.updateMatrixWorld(true);
      lLower.getWorldPosition(posNeg);

      this.armSignLeft = posPos.y < posNeg.y ? 1 : -1;
      lUpper.rotation.z = this.armSignLeft * 1.18;
    }

    if (rUpper && rLower) {
      this.armSignRight = -this.armSignLeft;
      rUpper.rotation.z = this.armSignRight * 1.18;
    }
  }

  _autoFrameCameraToHead() {
    if (!this.vrm || !this.vrm.humanoid || !this.camera) return;
    this.vrm.update(0);
    this.vrm.scene.updateMatrixWorld(true);

    const headNode = this.vrm.humanoid.getNormalizedBoneNode('head');
    if (headNode) {
      const headWorldPos = new THREE.Vector3();
      headNode.getWorldPosition(headWorldPos);
      const targetY = headWorldPos.y - 0.04;
      this.camera.position.set(0.0, targetY, 1.32);
      this.camera.lookAt(0.0, targetY - 0.02, 0.0);
      this.lookAtTarget.position.set(0.0, targetY, 1.32);
    }
  }

  /**
   * Phân rã một từ (Tiếng Việt hoặc Tiếng Anh) thành chuỗi nguyên âm VRM (aa, ih, ou, ee, oh)
   * hỗ trợ cả nguyên âm đôi/ba (ví dụ: "chào" -> ['aa','ou'], "tiếng" -> ['ih','ee'], "của" -> ['ou','aa'])
   */
  _decomposeWordVisemes(word) {
    const w = (word || '').toLowerCase().trim();
    if (!w) return ['aa'];

    const visemes = [];
    for (let i = 0; i < w.length; i++) {
      const ch = w[i];
      let v = null;
      if (/[aăâàáạảãằắặẳẵầấậẩẫ]/.test(ch)) {
        v = 'aa';
      } else if (/[oôơòóọỏõồốộổỗờớợởỡ]/.test(ch)) {
        v = 'oh';
      } else if (/[uưùúụủũừứựửữw]/.test(ch)) {
        v = 'ou';
      } else if (/[eêèéẹẻẽềếệểễ]/.test(ch)) {
        v = 'ee';
      } else if (/[iyìíịỉĩỳýỵỷỹ]/.test(ch)) {
        v = 'ih';
      }
      if (v && visemes[visemes.length - 1] !== v) {
        visemes.push(v);
      }
    }

    if (visemes.length === 0) return ['ih'];
    // Tối đa 2 nguyên âm chính mỗi từ để chuyển động môi rõ nét, không bị rung quá nhanh
    return visemes.slice(0, 2);
  }

  /**
   * Xây dựng bảng phân cảnh khẩu hình (Viseme Timeline) theo mili-giây từ WordBoundary
   */
  _buildVisemeTimeline(text, wordBoundaries = []) {
    if (!Array.isArray(wordBoundaries) || wordBoundaries.length === 0) {
      return [];
    }

    const timeline = [];
    for (let i = 0; i < wordBoundaries.length; i++) {
      const wb = wordBoundaries[i];
      const nextWb = wordBoundaries[i + 1];
      const startMs = wb.offsetMs;
      let durMs = wb.durationMs || 180;
      if (nextWb && startMs + durMs > nextWb.offsetMs) {
        durMs = Math.max(50, nextWb.offsetMs - startMs);
      }

      const visemes = this._decomposeWordVisemes(wb.text);
      // 82% thời lượng đầu của từ dành cho nguyên âm mở miệng, 18% cuối khép nhẹ môi (phụ âm cuối)
      const activeDur = durMs * 0.84;
      const stepDur = activeDur / visemes.length;

      for (let vIdx = 0; vIdx < visemes.length; vIdx++) {
        timeline.push({
          word: wb.text,
          vowel: visemes[vIdx],
          startMs: startMs + vIdx * stepDur,
          endMs: startMs + (vIdx + 1) * stepDur,
          wordEndMs: startMs + durMs
        });
      }
    }
    return timeline;
  }

  _extractVowelSequence(text) {
    if (!text) return ['aa', 'oh', 'ee', 'ih', 'ou'];
    const words = text.toLowerCase().split(/[\s,.;!?]+/).filter(Boolean);
    const seq = [];
    for (const w of words) {
      seq.push(...this._decomposeWordVisemes(w));
    }
    return seq.length > 0 ? seq : ['aa', 'oh', 'ee', 'ih', 'ou'];
  }

  /**
   * INTERFACE BẮT BUỘC: setEmotion(emotion)
   */
  setEmotion(emotion = AURA_EMOTIONS.NEUTRAL) {
    this.currentEmotion = emotion;
    switch (emotion) {
      case AURA_EMOTIONS.HAPPY:
        this.targetEmotionWeights = { happy: 0.30, angry: 0, sad: 0, relaxed: 0.10, surprised: 0 };
        break;
      case AURA_EMOTIONS.SERIOUS:
        this.targetEmotionWeights = { happy: 0, angry: 0.38, sad: 0, relaxed: 0, surprised: 0 };
        break;
      case AURA_EMOTIONS.APOLOGETIC:
        this.targetEmotionWeights = { happy: 0, angry: 0, sad: 0.55, relaxed: 0, surprised: 0 };
        break;
      case AURA_EMOTIONS.SURPRISED:
        this.targetEmotionWeights = { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0.7 };
        break;
      case AURA_EMOTIONS.NEUTRAL:
      default:
        this.targetEmotionWeights = { happy: 0, angry: 0, sad: 0, relaxed: 0.02, surprised: 0 };
        break;
    }
  }

  /**
   * INTERFACE BẮT BUỘC: speak(text, emotion, audioElementOrNode, wordBoundaries)
   */
  async speak(text, emotion = AURA_EMOTIONS.NEUTRAL, audioElementOrNode = null, wordBoundaries = []) {
    this.setEmotion(emotion);
    this.triggerNod(0.45);
    // Chớp mắt tự nhiên ngay khi bắt đầu câu nói
    this.blinkPhase = 0;
    this.blinkTimer = 0;

    this.isSpeaking = true;
    this.simSpeechText = text || '';
    this.speechVowelList = this._extractVowelSequence(this.simSpeechText);
    this.speechVowelIndex = 0;
    this.activeVowel = this.speechVowelList[0] || 'aa';
    this.secondaryVowel = 'oh';
    this.visemeTimeline = this._buildVisemeTimeline(this.simSpeechText, wordBoundaries);
    this.activeAudioElement = audioElementOrNode instanceof HTMLMediaElement ? audioElementOrNode : null;

    this.envFast = 0;
    this.envSlow = 0;
    this.wasInSyllablePeak = false;
    this.wasInWord = false;
    this.peakAudioRms = 0;
    this.peakMouthOpen = 0;

    if (audioElementOrNode) {
      this.simSpeechDuration = 0;
      this.simSpeechTimer = 0;
      this._connectAudioAnalyser(audioElementOrNode);
    } else {
      const wordCount = Math.max(3, this.simSpeechText.split(/\s+/).length);
      this.simSpeechDuration = Math.min(12.0, Math.max(2.2, wordCount * 0.32));
      this.simSpeechTimer = 0;
    }

    if (this.eventBus) {
      this.eventBus.emit('avatar:speak:start', {
        text,
        emotion,
        visemeCount: this.visemeTimeline.length
      });
    }
  }

  _connectAudioAnalyser(audioSource) {
    try {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }
      if (!this.analyserNode) {
        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = 512;
        this.analyserNode.smoothingTimeConstant = 0.20;
        this.freqData = new Uint8Array(this.analyserNode.frequencyBinCount);
        this.timeData = new Uint8Array(this.analyserNode.fftSize);
      }

      if (audioSource instanceof HTMLMediaElement) {
        if (!audioSource._auraMediaNode) {
          audioSource._auraMediaNode = this.audioContext.createMediaElementSource(audioSource);
          audioSource._auraMediaNode.connect(this.analyserNode);
          this.analyserNode.connect(this.audioContext.destination);
        }
      } else if (audioSource instanceof AudioNode) {
        audioSource.connect(this.analyserNode);
      }
    } catch (err) {
      console.warn('[VRMAvatarEngine] AnalyserNode fallback:', err);
    }
  }

  /**
   * INTERFACE BẮT BUỘC: stop()
   */
  stop() {
    this.isSpeaking = false;
    this.activeAudioElement = null;
    this.visemeTimeline = [];
    this.simSpeechTimer = 0;
    this.simSpeechDuration = 0;
    this.currentAudioRms = 0;
    this.envFast = 0;
    this.envSlow = 0;
    this.mouthWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this.targetMouthWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    this._applyMouthBlendshapes();
    this.setEmotion(AURA_EMOTIONS.NEUTRAL);

    // Chớp mắt nhẹ khi vừa kết thúc câu nói
    this.blinkPhase = 0;
    this.blinkTimer = 0;

    if (this.eventBus) {
      this.eventBus.emit('avatar:speak:stop', {});
    }
  }

  setLiteMode(enabled, reason = 'RAM > 90%') {
    if (this.isLiteMode === enabled) return;
    this.isLiteMode = enabled;
    this.liteModeReason = enabled ? reason : '';
    this._onResize();

    if (this.eventBus) {
      this.eventBus.emit('avatar:litemode', { enabled, reason: this.liteModeReason });
    }
  }

  setGazeTarget(normalizedX, normalizedY) {
    this.mouseX = Math.max(-1, Math.min(1, normalizedX));
    this.mouseY = Math.max(-1, Math.min(1, normalizedY));
    this.lastMouseMoveTime = performance.now();
  }

  triggerNod(intensity = 1.0) {
    this.nodDuration = 0.58;
    this.nodTimer = 0.001;
    this.nodIntensity = intensity;
  }

  getStats() {
    return {
      fps: this.currentFps,
      maxFps: (this.isLiteMode && !this.isSpeaking) ? this.liteFps : this.maxFps,
      isLiteMode: this.isLiteMode,
      liteModeReason: this.liteModeReason,
      emotion: this.currentEmotion,
      isSpeaking: this.isSpeaking,
      visemeCount: this.visemeTimeline.length,
      audioRms: Number(this.currentAudioRms.toFixed(3)),
      peakAudioRms: Number(this.peakAudioRms.toFixed(3)),
      peakMouthOpen: Number(this.peakMouthOpen.toFixed(3)),
      mouthWeights: {
        aa: Number(this.mouthWeights.aa.toFixed(3)),
        ih: Number(this.mouthWeights.ih.toFixed(3)),
        ou: Number(this.mouthWeights.ou.toFixed(3)),
        ee: Number(this.mouthWeights.ee.toFixed(3)),
        oh: Number(this.mouthWeights.oh.toFixed(3))
      },
      totalTextures: this.totalTextureCount,
      downsampledTextures: this.downsampledTextureCount
    };
  }

  _renderLoop(timestamp) {
    requestAnimationFrame((ts) => this._renderLoop(ts));

    const targetFps = (this.isLiteMode && !this.isSpeaking) ? this.liteFps : this.maxFps;
    const frameInterval = 1000 / targetFps;
    const elapsedMs = timestamp - this.lastFrameTimestamp;

    if (elapsedMs < frameInterval - 1.0) {
      return;
    }

    const deltaSec = Math.min(0.08, elapsedMs / 1000);
    this.lastFrameTimestamp = timestamp - (elapsedMs % frameInterval);
    this.elapsedTime += deltaSec;

    this.frameCount++;
    this.fpsAccumTime += elapsedMs;
    if (this.fpsAccumTime >= 500) {
      this.currentFps = Math.round((this.frameCount * 1000) / this.fpsAccumTime);
      this.frameCount = 0;
      this.fpsAccumTime = 0;
    }

    if (this.vrm) {
      this._updateGazeAndPose(deltaSec);
      this._updateEmotions(deltaSec);
      this._updateBlinking(deltaSec);
      this._updateLipSync(deltaSec);
      this.vrm.update(deltaSec);
    }

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  _updateGazeAndPose(dt) {
    // 1. Chuyển động vi mô của ánh mắt (Micro-saccades)
    this.saccadeTimer -= dt;
    if (this.saccadeTimer <= 0) {
      if (this.isSpeaking) {
        this.saccadeX = (Math.random() - 0.5) * 0.11;
        this.saccadeY = (Math.random() - 0.5) * 0.07;
        this.saccadeTimer = 0.5 + Math.random() * 0.85;
      } else {
        this.saccadeX = (Math.random() - 0.5) * 0.07;
        this.saccadeY = (Math.random() - 0.5) * 0.05;
        this.saccadeTimer = 1.4 + Math.random() * 1.8;
      }
    }

    // 2. Xử lý Eye Contact tự nhiên:
    // Nếu đang nói HOẶC chuột đang ở vùng bảng điều khiển bên dưới (mouseY < -0.25)
    // HOẶC chuột không di chuyển quá 1.8 giây -> Aura ngẩng đầu nhìn thẳng vào mắt người dùng!
    const mouseIdleMs = performance.now() - this.lastMouseMoveTime;
    const isMouseOnBottomPanel = this.mouseY < -0.25;

    let desiredX = this.mouseX;
    let desiredY = this.mouseY;

    if (this.isSpeaking || isMouseOnBottomPanel || mouseIdleMs > 1800) {
      // Nhìn thẳng giao tiếp bằng mắt (Eye Contact) với người dùng
      desiredX = this.mouseX * 0.22;
      desiredY = 0.04;
    } else {
      // Giới hạn góc liếc dọc để tròng mắt không bao giờ bị trợn hoặc nhìn chúc xuống đất
      desiredX = Math.max(-0.65, Math.min(0.65, this.mouseX));
      desiredY = Math.max(-0.22, Math.min(0.32, this.mouseY));
    }

    const targetX = desiredX + this.saccadeX;
    const targetY = desiredY + this.saccadeY;

    const lerpFactor = Math.min(1.0, dt * 7.5);
    this.smoothGazeX += (targetX - this.smoothGazeX) * lerpFactor;
    this.smoothGazeY += (targetY - this.smoothGazeY) * lerpFactor;

    if (this.lookAtTarget && this.camera) {
      this.lookAtTarget.position.x = this.smoothGazeX * 0.52;
      this.lookAtTarget.position.y = this.camera.position.y + this.smoothGazeY * 0.32;
      this.lookAtTarget.position.z = 1.35;
    }

    const h = this.vrm.humanoid;
    if (!h) return;

    const t = this.elapsedTime;

    // 3. Nhịp thở nhẹ nhàng (Spine & Chest)
    const spine = h.getNormalizedBoneNode('spine');
    const chest = h.getNormalizedBoneNode('chest');
    if (spine) {
      spine.rotation.x = Math.sin(t * 1.9) * 0.014;
      spine.rotation.z = Math.cos(t * 1.1) * 0.007;
    }
    if (chest) {
      chest.rotation.x = Math.sin(t * 1.9 - 0.4) * 0.016;
    }

    // 4. Chuyển động đầu & cổ tự nhiên theo giọng nói
    const neck = h.getNormalizedBoneNode('neck');
    const head = h.getNormalizedBoneNode('head');

    let nodOffset = 0;
    if (this.nodTimer > 0) {
      this.nodTimer += dt;
      if (this.nodTimer <= this.nodDuration) {
        const progress = this.nodTimer / this.nodDuration;
        nodOffset = Math.sin(progress * Math.PI * 2) * 0.085 * this.nodIntensity;
      } else {
        this.nodTimer = 0;
      }
    }

    const apologyPitch = this.currentEmotion === AURA_EMOTIONS.APOLOGETIC ? 0.10 : 0;
    const happyTilt = this.currentEmotion === AURA_EMOTIONS.HAPPY ? 0.04 : 0;

    const voiceEmphasisPitch = this.isSpeaking ? (this.envFast * 0.045 + Math.sin(t * 4.8) * 0.014) : 0;
    const voiceEmphasisRoll = this.isSpeaking ? Math.sin(t * 2.5) * 0.022 : 0;

    if (neck) {
      neck.rotation.y = this.smoothGazeX * 0.13;
      neck.rotation.x = -this.smoothGazeY * 0.07 + apologyPitch * 0.45 + voiceEmphasisPitch * 0.35;
    }
    if (head) {
      head.rotation.y = this.smoothGazeX * 0.22 + Math.sin(t * 0.7) * 0.012;
      head.rotation.x = -this.smoothGazeY * 0.11 + nodOffset + apologyPitch + voiceEmphasisPitch;
      head.rotation.z = happyTilt + voiceEmphasisRoll + Math.sin(t * 0.9) * 0.012 - this.smoothGazeX * 0.03;
    }

    // 5. Cánh tay thả lỏng tự nhiên
    const lUpper = h.getNormalizedBoneNode('leftUpperArm');
    const rUpper = h.getNormalizedBoneNode('rightUpperArm');
    const lLower = h.getNormalizedBoneNode('leftLowerArm');
    const rLower = h.getNormalizedBoneNode('rightLowerArm');

    const breathArm = Math.sin(t * 1.9) * 0.016;
    if (lUpper) {
      lUpper.rotation.z = this.armSignLeft * (1.18 + breathArm);
      lUpper.rotation.x = 0.06;
    }
    if (rUpper) {
      rUpper.rotation.z = this.armSignRight * (1.18 + breathArm);
      rUpper.rotation.x = 0.06;
    }
    if (lLower) {
      lLower.rotation.z = this.armSignLeft * 0.08;
      lLower.rotation.y = -this.armSignLeft * 0.15;
    }
    if (rLower) {
      rLower.rotation.z = this.armSignRight * 0.08;
      rLower.rotation.y = -this.armSignRight * 0.15;
    }
  }

  _updateEmotions(dt) {
    const em = this.vrm.expressionManager;
    if (!em) return;

    const speed = Math.min(1.0, dt * 6.5);
    for (const key of Object.keys(this.emotionWeights)) {
      let targetVal = this.targetEmotionWeights[key] || 0;

      // Khi đang nói (isSpeaking), giữ 'happy' <= 0.06 và 'relaxed' = 0
      // để đôi mắt mở to long lanh và khuôn miệng hoàn toàn do bộ Lip-Sync điều khiển!
      if (this.isSpeaking) {
        if (key === 'happy') targetVal = Math.min(0.06, targetVal);
        if (key === 'relaxed') targetVal = 0;
        if (key === 'sad') targetVal = Math.min(0.25, targetVal);
        if (key === 'angry') targetVal = Math.min(0.22, targetVal);
      }

      if (this.blinkValue > 0.08 && (key === 'happy' || key === 'relaxed')) {
        targetVal *= (1.0 - this.blinkValue);
      }

      this.emotionWeights[key] += (targetVal - this.emotionWeights[key]) * speed;
      em.setValue(key, this.emotionWeights[key]);
    }
  }

  _updateBlinking(dt) {
    const em = this.vrm.expressionManager;
    if (!em) return;

    this.blinkTimer += dt;
    if (this.blinkPhase < 0 && this.blinkTimer >= this.nextBlinkInterval) {
      this.blinkPhase = 0;
      this.blinkTimer = 0;
      if (this.isSpeaking) {
        this.nextBlinkInterval = Math.random() < 0.20 ? 0.22 : 1.7 + Math.random() * 1.5;
      } else {
        this.nextBlinkInterval = Math.random() < 0.15 ? 0.24 : 2.6 + Math.random() * 2.5;
      }
    }

    if (this.blinkPhase >= 0) {
      const blinkDuration = 0.135;
      this.blinkPhase += dt / blinkDuration;
      if (this.blinkPhase >= 1.0) {
        this.blinkPhase = -1;
        this.blinkValue = 0;
      } else {
        const s = Math.sin(this.blinkPhase * Math.PI);
        this.blinkValue = Math.pow(s, 0.85);
      }
    }

    const maxBlink = 1.0 - Math.min(0.5, this.emotionWeights.happy * 0.9);
    em.setValue('blink', Math.min(maxBlink, this.blinkValue));
  }

  /**
   * Giải thuật Hybrid Lip-Sync (WordBoundary Timeline + AnalyserNode Envelope):
   * - Kết hợp chính xác mili-giây phát âm từng từ (audioEl.currentTime * 1000) từ edge-tts
   *   với biên độ âm thanh thực từ AnalyserNode.
   * - Giữa mỗi từ và ở các dấu phẩy/chấm, miệng khép dứt khoát như người thật.
   */
  _updateLipSync(dt) {
    if (!this.isSpeaking) return;

    if (this.analyserNode && this.freqData && this.simSpeechDuration === 0) {
      this.analyserNode.getByteFrequencyData(this.freqData);

      // 1. Đo biên độ RMS thực từ sóng âm miền thời gian
      let rms = 0;
      if (this.timeData) {
        this.analyserNode.getByteTimeDomainData(this.timeData);
        let sumSq = 0;
        for (let i = 0; i < this.timeData.length; i++) {
          const norm = (this.timeData[i] - 128) / 128.0;
          sumSq += norm * norm;
        }
        rms = Math.sqrt(sumSq / this.timeData.length);
      }

      // 2. Đo năng lượng tuyến tính trên 3 dải tần Formant giọng nữ
      let fLow = 0;
      let fMid = 0;
      let fHigh = 0;

      for (let i = 2; i < 9; i++) fLow += Math.pow(this.freqData[i] / 255.0, 2.6);
      for (let i = 9; i < 26; i++) fMid += Math.pow(this.freqData[i] / 255.0, 2.6);
      for (let i = 26; i < 54; i++) fHigh += Math.pow(this.freqData[i] / 255.0, 2.6);

      fLow /= 7;
      fMid /= 17;
      fHigh /= 28;

      const rawSignal = Math.max(rms * 2.6, (fLow + fMid * 1.2 + fHigh * 0.8) * 0.9);
      this.currentAudioRms = Math.min(1.0, rawSignal);
      if (this.currentAudioRms > this.peakAudioRms) {
        this.peakAudioRms = this.currentAudioRms;
      }

      const fastRate = rawSignal > this.envFast ? Math.min(1.0, dt * 40.0) : Math.min(1.0, dt * 26.0);
      const slowRate = Math.min(1.0, dt * 5.5);
      this.envFast += (rawSignal - this.envFast) * fastRate;
      this.envSlow += (rawSignal - this.envSlow) * slowRate;

      this.targetMouthWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

      // 3. Nếu có mốc thời gian từng từ (WordBoundary Timeline) + activeAudioElement
      if (this.activeAudioElement && this.visemeTimeline.length > 0) {
        const currentMs = this.activeAudioElement.currentTime * 1000;
        let matchedSeg = null;

        for (let i = 0; i < this.visemeTimeline.length; i++) {
          const seg = this.visemeTimeline[i];
          if (currentMs >= seg.startMs - 15 && currentMs <= seg.endMs + 10) {
            matchedSeg = seg;
            break;
          }
        }

        if (matchedSeg && this.envFast > 0.015) {
          this.wasInWord = true;
          const segDur = Math.max(30, matchedSeg.endMs - matchedSeg.startMs);
          const localPhase = Math.max(0, Math.min(1, (currentMs - matchedSeg.startMs) / segDur));

          // Đường cong mở - khép tự nhiên của từng nguyên âm trong từ
          const syllableCurve = Math.sin(localPhase * Math.PI);
          const audioBoost = Math.min(1.15, 0.45 + this.envFast * 1.35);
          const openWeight = Math.min(0.66, syllableCurve * audioBoost * 0.62);

          this.targetMouthWeights[matchedSeg.vowel] = openWeight;

          // Pha trộn nhẹ (15%) đặc trưng tần số thực tế để miệng mềm mại
          if (matchedSeg.vowel === 'aa' && fLow > fMid) {
            this.targetMouthWeights.oh = openWeight * 0.2;
          } else if (matchedSeg.vowel === 'oh' && fHigh > fLow) {
            this.targetMouthWeights.ou = openWeight * 0.22;
          }
        } else {
          // Đang ở khoảng nghỉ phụ âm giữa 2 từ hoặc dấu câu -> khép miệng dứt khoát!
          if (this.wasInWord) {
            this.wasInWord = false;
            // Nếu nghỉ giữa câu > 160ms, kích hoạt chớp mắt nhẹ tự nhiên (nhịp chớp mắt khi ngắt câu)
            if (this.blinkPhase < 0 && this.blinkTimer > 0.9 && Math.random() < 0.35) {
              this.blinkPhase = 0;
              this.blinkTimer = 0;
            }
          }
        }
      } else {
        // 4. Fallback nếu không có WordBoundary: Dùng bộ dò âm tiết Dual-Envelope
        const isSyllablePeak = this.envFast > 0.035 && this.envFast >= this.envSlow * 0.88;
        if (isSyllablePeak && !this.wasInSyllablePeak) {
          this.wasInSyllablePeak = true;
          this.speechVowelIndex = (this.speechVowelIndex + 1) % this.speechVowelList.length;
          this.activeVowel = this.speechVowelList[this.speechVowelIndex];
        } else if (this.envFast < this.envSlow * 0.76 || this.envFast < 0.028) {
          this.wasInSyllablePeak = false;
        }

        if (this.envFast >= 0.025) {
          const syllableArticulation = this.wasInSyllablePeak ? 1.0 : 0.20;
          const normalizedOpen = Math.min(1.0, (this.envFast - 0.02) * 2.1) * syllableArticulation;
          this.targetMouthWeights[this.activeVowel] = Math.min(0.65, normalizedOpen * 0.65);
        }
      }

      // 5. Nội suy cực nhạy (Fast Attack 32/s, Crisp Release 26/s) sang mouthWeights
      for (const k of ['aa', 'ih', 'ou', 'ee', 'oh']) {
        const target = this.targetMouthWeights[k] || 0;
        const curr = this.mouthWeights[k] || 0;
        const speed = target > curr ? Math.min(1.0, dt * 32.0) : Math.min(1.0, dt * 26.0);
        this.mouthWeights[k] = curr + (target - curr) * speed;
        if (this.mouthWeights[k] < 0.005) this.mouthWeights[k] = 0;
      }

      const maxMouth = Math.max(
        this.mouthWeights.aa,
        this.mouthWeights.oh,
        this.mouthWeights.ou,
        this.mouthWeights.ee,
        this.mouthWeights.ih
      );
      if (maxMouth > this.peakMouthOpen) {
        this.peakMouthOpen = maxMouth;
      }

      this._applyMouthBlendshapes();
      return;
    }

    // Trường hợp 2: Mô phỏng nhịp nguyên âm theo văn bản (nút "Thử mấp máy môi")
    if (this.simSpeechDuration > 0) {
      this.simSpeechTimer += dt;
      if (this.simSpeechTimer >= this.simSpeechDuration) {
        this.stop();
        return;
      }
      const syllableRate = this.simSpeechTimer * 5.2;
      const syllablePhase = syllableRate % 1.0;
      const idx = Math.floor(syllableRate) % this.speechVowelList.length;
      const vKey = this.speechVowelList[idx];

      const open = syllablePhase < 0.72
        ? Math.sin((syllablePhase / 0.72) * Math.PI) * 0.58
        : 0;

      this.currentAudioRms = open;
      this.mouthWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
      this.mouthWeights[vKey] = open;
      if (open > this.peakMouthOpen) this.peakMouthOpen = open;
      this._applyMouthBlendshapes();
    }
  }

  _applyMouthBlendshapes() {
    const em = this.vrm?.expressionManager;
    if (!em) return;
    em.setValue('aa', this.mouthWeights.aa);
    em.setValue('ih', this.mouthWeights.ih);
    em.setValue('ou', this.mouthWeights.ou);
    em.setValue('ee', this.mouthWeights.ee);
    em.setValue('oh', this.mouthWeights.oh);
  }
}
