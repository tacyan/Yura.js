/** Validate export options before starting Chrome or ffmpeg. */
export function filmOptions(argv: readonly string[], defaults: { fps: number; duration: number }) {
  const values = new Map<string, string>()
  const valueFlags = new Set(['--out', '--fps', '--from', '--to', '--jpeg-quality'])
  let script: string | undefined
  let audio = true
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-audio') {
      audio = false
    } else if (valueFlags.has(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (values.has(arg)) throw new Error(`${arg} was specified more than once`)
      values.set(arg, value)
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    } else if (script === undefined) {
      script = arg
    } else {
      throw new Error(`Unexpected argument: ${arg}`)
    }
  }
  if (!script) throw new Error('A film script path is required')
  const number = (flag: string, fallback: number): number => {
    const raw = values.get(flag)
    const value = raw === undefined ? fallback : Number(raw)
    if (!Number.isFinite(value) || (raw !== undefined && !raw.trim())) throw new Error(`${flag} must be a finite number`)
    return value
  }
  const fps = Math.max(12, Math.min(60, number('--fps', defaults.fps)))
  const from = Math.max(0, number('--from', 0))
  const to = Math.min(defaults.duration, number('--to', defaults.duration))
  if (to <= from) throw new Error('Export range must satisfy 0 <= from < to <= film duration')
  const quality = Math.max(50, Math.min(100, number('--jpeg-quality', 95)))
  return { script, out: values.get('--out'), fps, from, to, quality, audio }
}
