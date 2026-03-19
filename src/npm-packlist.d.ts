declare module "npm-packlist" {
  export default function packlist(tree: unknown): Promise<string[]>;
}
