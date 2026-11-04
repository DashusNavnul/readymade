import tseslint from 'typescript-eslint';
export default tseslint.config(...tseslint.configs.recommended, {
  files: ['src/**/*.ts', 'tests/**/*.ts'],
  rules: {'@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}]}
}, {
  files: ['platform/*.cjs', 'tests/*.cjs'],
  rules: {'@typescript-eslint/no-require-imports':'off'},
  languageOptions: { globals: {require:'readonly', module:'readonly', __dirname:'readonly', process:'readonly', Buffer:'readonly', URL:'readonly', setTimeout:'readonly', clearTimeout:'readonly', console:'readonly'} }
});
