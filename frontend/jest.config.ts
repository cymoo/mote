import type { Config } from '@jest/types'
const config: Config.InitialOptions = {
  verbose: true,
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^marked$': '<rootDir>/tests/mocks/marked.ts',
  },
  testEnvironment: 'jsdom',
  roots: ['./tests'],
}
export default config
