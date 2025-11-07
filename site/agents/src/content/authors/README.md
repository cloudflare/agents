# Authors Collection

This directory contains author data files in JSON format. Each author file should be named using a slug (e.g., `jane-doe.json`).

## Author Schema

Each author file should follow this structure:

```json
{
  "name": "Author Name",
  "bio": "A short biography of the author.",
  "avatar": "/images/authors/author-slug.jpg",
  "social": {
    "twitter": "https://twitter.com/username",
    "github": "https://github.com/username",
    "linkedin": "https://linkedin.com/in/username",
    "website": "https://example.com"
  }
}
```

## Adding a New Author

1. Create a new JSON file in this directory (e.g., `new-author.json`)
2. Fill in the author information
3. Add the author's profile picture to `/public/images/authors/` with the same name (e.g., `new-author.jpg`)
4. Reference the author by their exact name in blog posts

## Using Authors in Blog Posts

In your blog post frontmatter, reference authors by their exact name:

```yaml
author: "Jane Doe"
```

Or for multiple authors:

```yaml
author: ["Jane Doe", "John Smith"]
```

The system will automatically:

- Display author avatars in post cards and headers
- Link to author profiles on the authors page
- Show author information throughout the blog

## Using AuthorProfile Component in Posts

You can include author profiles directly in your blog posts (especially useful in MDX):

```astro
---
import AuthorProfile from '../../components/blog/AuthorProfile.astro';
import { getAuthorByName } from '../../utils/authors';

const author = await getAuthorByName("Jane Doe");
---

<AuthorProfile author={author} size="medium" />
```

Available sizes: `small`, `medium`, `large`
