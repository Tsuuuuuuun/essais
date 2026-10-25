import { rm } from 'node:fs/promises';
import { md } from './lib/markdown.js';
import { kanjiDate } from './lib/kanji.js';
import { ORDER_FILE, readOrder, sortPosts } from './lib/order.js';
import { publishedSlugs } from './lib/post.js';
import { excerpt, plainText, writeOgImages } from './lib/og.js';

export default function (eleventyConfig) {
  // 原稿の変換は lib/markdown.js（執筆画面のプレビューと共通）
  eleventyConfig.setLibrary('md', md);

  eleventyConfig.addPassthroughCopy('src/assets');
  // 一回きりのビルド（pnpm build / deploy）では、書き出す前に _site/ を空にする。
  // 消した原稿や下書きに戻した原稿の頁が残って、公開されてしまわないように
  eleventyConfig.on('eleventy.before', async ({ runMode, directories }) => {
    if (runMode === 'build') await rm(directories.output, { recursive: true, force: true });
  });

  // OGP 画像（lib/og.js）。Chrome で撮るので時間がかかり、一回きりのビルドでだけ作る
  eleventyConfig.on('eleventy.after', async ({ runMode, results }) => {
    if (runMode === 'build') await writeOgImages(results);
  });

  // 画像は下書きでも消したものでもない記事のぶんだけ写す。どちらかは設定を読んだ時点で決まる
  for (const slug of publishedSlugs()) {
    eleventyConfig.addPassthroughCopy(`src/posts/${slug}/*.{jpg,jpeg,png,gif,webp,avif,svg}`);
  }

  // draft: true の原稿（下書き）と deleted: true の原稿（消したもの）は書き出さず、目次にも載せない
  eleventyConfig.addPreprocessor('drafts', 'md', (data) => {
    if (data.draft === true || data.deleted === true) return false;
  });

  eleventyConfig.addFilter('kanjiDate', kanjiDate);
  eleventyConfig.addFilter('plainText', plainText);
  eleventyConfig.addFilter('excerpt', excerpt);
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
