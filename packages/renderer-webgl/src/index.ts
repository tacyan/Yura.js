export { WebGL2ParticleRenderer } from './renderer'
export { SIM_VS, RENDER_VS, RENDER_FS, FS_TRIANGLE_VS, FADE_FS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS } from './shaders'
// Single-source builders/constants shared with the WebGPU backend (re-exported
// by shaders.ts from @yura/renderer-webgpu) plus the composite-FS builder.
export { buildCompositeFs, DEFAULT_TURBULENCE, DEFAULT_TURBULENCE_SCALE, packAttractors, MAX_ATTRACTORS, ATTRACTOR_VEC4S, ATTRACTOR_RADIUS2_SLOT, ATTRACTOR_ARRAY_VEC4S, DEFAULT_ATTRACTOR_RADIUS, ATTRACTOR_DIST_EPSILON } from './shaders'
export type { AttractorParams } from './shaders'
