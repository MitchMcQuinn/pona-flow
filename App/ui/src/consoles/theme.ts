import { createTheme, type CSSVariablesResolver, type MantineColor, type MantineTheme } from '@mantine/core'

const black = [
  '#ffffff',
  '#e7e7e7',
  '#c7c7c7',
  '#8a8a8a',
  '#484848',
  '#141414',
  '#000000',
  '#000000',
  '#000000',
  '#000000',
] as const

const accent = [
  '#eef2ff',
  '#e0e7ff',
  '#c7d2fe',
  '#a5b4fc',
  '#818cf8',
  '#6366f1',
  '#4f46e5',
  '#4338ca',
  '#3730a3',
  '#312e81',
] as const

const none = { xs: '0', sm: '0', md: '0', lg: '0', xl: '0' }

type ButtonPaint = {
  variant?: string
  color?: MantineColor
}

function buttonPaint({ variant, color }: ButtonPaint) {
  const kind = variant ?? 'filled'
  if (color === 'red') return 'danger'
  if (kind === 'default') return 'secondary'
  if (kind === 'subtle' || kind === 'transparent') return 'quiet'
  if (kind === 'filled' && (color == null || color === 'accent')) return 'mesh'
  return 'plain'
}

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {},
  dark: {
    '--mantine-color-text': '#ffffff',
    '--mantine-color-body': '#000000',
    '--mantine-color-dimmed': '#c7c7c7',
    '--mantine-color-placeholder': 'rgba(255, 255, 255, 0.45)',
    '--mantine-color-default': '#000000',
    '--mantine-color-default-hover': 'rgba(255, 255, 255, 0.08)',
    '--mantine-color-default-color': '#ffffff',
    '--mantine-color-default-border': 'rgba(255, 255, 255, 0.28)',
    '--mantine-color-error': '#fb7185',
    '--mantine-color-success': '#34d399',
    '--mantine-color-anchor': '#818cf8',
  },
})

export const theme = createTheme({
  primaryColor: 'accent',
  primaryShade: 4,
  defaultRadius: 0,
  black: '#000000',
  white: '#ffffff',
  fontFamily: '"Roboto", ui-sans-serif, system-ui, sans-serif',
  fontFamilyMonospace: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  headings: {
    fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    fontWeight: '700',
    sizes: {
      h1: { fontSize: '2rem', lineHeight: '1.05', fontWeight: '700' },
      h2: { fontSize: '1.625rem', lineHeight: '1.05', fontWeight: '700' },
      h3: { fontSize: '1.25rem', lineHeight: '1.05', fontWeight: '700' },
      h4: { fontSize: '1.05rem', lineHeight: '1.05', fontWeight: '700' },
    },
  },
  radius: none,
  shadows: { xs: 'none', sm: 'none', md: 'none', lg: 'none', xl: 'none' },
  colors: {
    dark: [...black],
    accent: [...accent],
  },
  components: {
    Button: {
      classNames: (_theme: MantineTheme, props: ButtonPaint) => ({
        root: buttonPaint(props) === 'mesh' ? 'mesh-button' : undefined,
      }),
      vars: (_theme: MantineTheme, props: ButtonPaint) => {
        const paint = buttonPaint(props)
        if (paint === 'mesh') {
          return {
            root: {
              '--button-bg': 'var(--mesh-fill)',
              '--button-color': '#ffffff',
              '--button-hover-color': '#ffffff',
              '--button-bd': '1px solid transparent',
            },
          }
        }
        if (paint === 'secondary') {
          return {
            root: {
              '--button-bg': 'rgba(6, 182, 212, 0.12)',
              '--button-hover': 'rgba(6, 182, 212, 0.22)',
              '--button-color': '#a5f3fc',
              '--button-hover-color': '#a5f3fc',
              '--button-bd': '1px solid rgba(6, 182, 212, 0.35)',
            },
          }
        }
        if (paint === 'danger') {
          return {
            root: {
              '--button-bg': 'rgba(251, 113, 133, 0.12)',
              '--button-hover': 'rgba(251, 113, 133, 0.22)',
              '--button-color': '#fecdd3',
              '--button-hover-color': '#fecdd3',
              '--button-bd': '1px solid rgba(251, 113, 133, 0.4)',
            },
          }
        }
        if (paint === 'quiet') {
          return {
            root: {
              '--button-bg': 'transparent',
              '--button-hover': 'transparent',
              '--button-color': '#c7c7c7',
              '--button-hover-color': '#ffffff',
              '--button-bd': '1px solid transparent',
            },
          }
        }
        return { root: {} }
      },
    },
  },
})
