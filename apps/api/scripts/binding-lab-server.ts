import {buildApp} from '../src/app.js';
const app=await buildApp();
await app.listen({host:'127.0.0.1',port:Number(process.env.API_PORT??18092)});
const stop=async()=>{await app.close();process.exit(0)};
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
