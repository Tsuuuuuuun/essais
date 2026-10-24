import { md } from './lib/markdown.js';
import { kanjiDate } from './lib/kanji.js';
import { ORDER_FILE, readOrder, sortPosts } from './lib/order.js';

export default function (eleventyConfig) {
  // 原稿の変換は lib/markdown.js（執筆画面のプレビューと共通）
  eleventyConfig.setLibrary('md', md);

  eleventyConfig.addPassthroughCopy('src/assets');
  eleventyConfig.addPassthroughCopy('src/posts/**/*.{jpg,jpeg,png,gif,webp,avif,svg}');

  eleventyConfig.addFilter('kanjiDate', kanjiDate);
  eleventyConfig.addFilter('inlineMd', (s) => md.renderInline(String(s ?? '')));

  // 目次の並び。src/posts/order.json の順（書き手が決めた順に読んでもらう）。並べ方は lib/order.js
  eleventyConfig.addWatchTarget(ORDER_FILE);
  eleventyConfig.addCollection('posts', (api) =>
    sortPosts(api.getFilteredByGlob('src/posts/*/index.md'), readOrder(), (p) => p.fileSlug, (p) => p.date)
  );

  return {
    dir: { input: 'src', includes: '_includes', data: '_data', output: '_site' },
    templateFormats: ['md', 'njk'],
    markdownTemplateEngine: false,
    htmlTemplateEngine: 'njk',
  };
}
