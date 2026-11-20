import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.yoob52.pickup",
  appName: "PickUp",
  webDir: "out/mobile",
  server: {
    androidScheme: "https",
    hostname: "localhost",
  },
};

export default config;
