// vite will already convert svg to base64
// but we add this to make typescript happy

declare module "*.svg" {
  const content: string;
  export default content;
}
