import { getCollection } from "astro:content";
import type { CollectionEntry } from "astro:content";

/**
 * Get author data by name (case-insensitive)
 */
export async function getAuthorByName(
  name: string
): Promise<CollectionEntry<"authors"> | undefined> {
  const authors = await getCollection("authors");
  return authors.find(
    (author) => author.data.name.toLowerCase() === name.toLowerCase()
  );
}

/**
 * Get multiple authors by their names
 */
export async function getAuthorsByNames(
  names: string[]
): Promise<CollectionEntry<"authors">[]> {
  const authors = await getCollection("authors");
  return names
    .map((name) =>
      authors.find(
        (author) => author.data.name.toLowerCase() === name.toLowerCase()
      )
    )
    .filter(
      (author): author is CollectionEntry<"authors"> => author !== undefined
    );
}

/**
 * Get all authors
 */
export async function getAllAuthors(): Promise<CollectionEntry<"authors">[]> {
  return await getCollection("authors");
}
