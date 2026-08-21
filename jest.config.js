module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@react-native-async-storage/async-storage$': '<rootDir>/src/__tests__/__mocks__/async-storage.ts',
    '^react-native-get-random-values$': '<rootDir>/src/__tests__/__mocks__/random-values.ts',
    '^expo-secure-store$': '<rootDir>/src/__tests__/__mocks__/secure-store.ts',
    '^expo-file-system/legacy$': '<rootDir>/src/__tests__/__mocks__/expo-file-system.ts',
    '^expo/fetch$': '<rootDir>/src/__tests__/__mocks__/expo-fetch.ts',
    '^@react-native-community/netinfo$': '<rootDir>/src/__tests__/__mocks__/netinfo.ts',
  },
};
