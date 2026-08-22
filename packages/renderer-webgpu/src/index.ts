export { WebGPUParticleRenderer } from './renderer'
export type { LookParams, MotionParams, RendererOptions, ExternalCamera } from './renderer'
export { WebGPUModelRenderer } from './model-renderer'
export type { SceneMaterial, MeshHandle } from './model-renderer'
export { meshes, sphereMesh, boxMesh, planeMesh, discMesh, torusMesh, cylinderMesh, torusKnotMesh } from './meshes'
export type { MeshGeometry } from './meshes'
export { loadGLB, parseGLB } from './gltf'
export type { GLTFModel, GLTFPrimitive, GLTFMaterial } from './gltf'
export { SIM_WGSL, RENDER_WGSL, POST_WGSL } from './shaders'
export { ENV_WGSL, BLIT_WGSL, PBR_WGSL, FX_WGSL } from './model-shaders'
export * from './blend'
export * from './look-math'
export { curlNoiseSource, turbulenceTermSource, DEFAULT_TURBULENCE, DEFAULT_TURBULENCE_SCALE } from './shaders'
export { attractorTermSource, packAttractors, MAX_ATTRACTORS, ATTRACTOR_VEC4S, ATTRACTOR_RADIUS2_SLOT, ATTRACTOR_ARRAY_VEC4S, DEFAULT_ATTRACTOR_RADIUS, ATTRACTOR_DIST_EPSILON, SIM_PARAMS_BYTES } from './shaders'
export type { AttractorParams } from './shaders'
// Single-source builders/constants shared with the WebGL backend and tests:
// shader-source builders, their named constants, and the sim-param layout.
export { shaderFloatLiteral, buildPostWgsl, CURL_HASH_SCALE, CURL_HASH_SHIFT, CURL_OFFSET_Y, CURL_OFFSET_Z, TURBULENCE_TIME_SCALE, SIM_ATTRACTOR_COUNT_INDEX, SIM_ATTRACTORS_INDEX } from './shaders'
export type { ShaderLang } from './shaders'
// Model-pipeline single sources: shadow pass, FX builder + soft-particle
// variant, and the model renderer's public defaults/helpers.
export { SHADOW_WGSL, buildFxWgsl, FX_SOFT_WGSL } from './model-shaders'
export { DEFAULT_SOFT_PARTICLES, computeLightViewProj } from './model-renderer'
export { dofVertexTermSource, dofSpriteProfileSource, buildRenderWgsl, DEFAULT_DOF_FOCUS, DEFAULT_DOF_STRENGTH, DOF_DEPTH_EPSILON, SPRITE_CORE_FALLOFF } from './shaders'
