import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const local=(path:string)=>fileURLToPath(new URL(path,import.meta.url));
export default defineConfig({
  plugins:[react()],
  resolve:{alias:[
    {find:/^react-native$/,replacement:local('./node_modules/react-native-web')},
    {find:/^react(?=\/|$)/,replacement:local('./node_modules/react')},
    {find:/^react-dom(?=\/|$)/,replacement:local('./node_modules/react-dom')},
  ]},
  server:{fs:{allow:[local('../..')] }},
});
