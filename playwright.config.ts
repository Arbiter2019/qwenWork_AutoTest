import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests',testMatch:'**/*.spec.ts',workers:1,use:{baseURL:'http://127.0.0.1:4317',headless:true,viewport:{width:1440,height:1000}},timeout:30000});
