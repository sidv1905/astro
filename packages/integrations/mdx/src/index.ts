import { compile as mdxCompile, nodeTypes } from '@mdx-js/mdx';
import mdxPlugin, { Options as MdxRollupPluginOptions } from '@mdx-js/rollup';
import type { AstroIntegration } from 'astro';
import { initializeAstroExportsPlugin, applyAstroExportsPlugin } from './astro-exports-plugins.js';
import { parse as parseESM } from 'es-module-lexer';
import rehypeRaw from 'rehype-raw';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import type { RemarkMdxFrontmatterOptions } from 'remark-mdx-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import remarkShikiTwoslash from 'remark-shiki-twoslash';
import remarkSmartypants from 'remark-smartypants';
import { VFile } from 'vfile';
import type { Plugin as VitePlugin } from 'vite';
import rehypeCollectHeadings from './rehype-collect-headings.js';
import remarkPrism from './remark-prism.js';
import { getFileInfo, getFrontmatter } from './utils.js';

type WithExtends<T> = T | { extends: T };

type MdxOptions = {
	remarkPlugins?: WithExtends<MdxRollupPluginOptions['remarkPlugins']>;
	rehypePlugins?: WithExtends<MdxRollupPluginOptions['rehypePlugins']>;
	/**
	 * Configure the remark-mdx-frontmatter plugin
	 * @see https://github.com/remcohaszing/remark-mdx-frontmatter#options for a full list of options
	 * @default {{ name: 'frontmatter' }}
	 */
	frontmatterOptions?: RemarkMdxFrontmatterOptions;
};

const DEFAULT_REMARK_PLUGINS = [remarkGfm, remarkSmartypants];
const DEFAULT_REHYPE_PLUGINS = [rehypeCollectHeadings];

function handleExtends<T>(config: WithExtends<T[] | undefined>, defaults: T[] = []): T[] {
	if (Array.isArray(config)) return config;

	return [...defaults, ...(config?.extends ?? [])];
}

export default function mdx(mdxOptions: MdxOptions = {}): AstroIntegration {
	return {
		name: '@astrojs/mdx',
		hooks: {
			'astro:config:setup': ({ updateConfig, config, addPageExtension, command }: any) => {
				addPageExtension('.mdx');
				let remarkPlugins = handleExtends(mdxOptions.remarkPlugins, DEFAULT_REMARK_PLUGINS);
				let rehypePlugins = handleExtends(mdxOptions.rehypePlugins, DEFAULT_REHYPE_PLUGINS);

				if (config.markdown.syntaxHighlight === 'shiki') {
					remarkPlugins.push([
						// Default export still requires ".default" chaining for some reason
						// Workarounds tried:
						// - "import * as remarkShikiTwoslash"
						// - "import { default as remarkShikiTwoslash }"
						(remarkShikiTwoslash as any).default,
						config.markdown.shikiConfig,
					]);
					rehypePlugins.push([rehypeRaw, { passThrough: nodeTypes }]);
				}

				if (config.markdown.syntaxHighlight === 'prism') {
					remarkPlugins.push(remarkPrism);
					rehypePlugins.push([rehypeRaw, { passThrough: nodeTypes }]);
				}

				remarkPlugins.push(remarkFrontmatter);
				remarkPlugins.push([
					remarkMdxFrontmatter,
					{
						name: 'frontmatter',
						...mdxOptions.frontmatterOptions,
					},
				]);

				// Insert "data.astroExports" initializer at the start
				// for userland plugins to access
				remarkPlugins.unshift(initializeAstroExportsPlugin);
				// Rehype plugins go last, so map astro exports here
				rehypePlugins.push(applyAstroExportsPlugin);

				const mdxPluginOpts: MdxRollupPluginOptions = {
					remarkPlugins,
					rehypePlugins,
					jsx: true,
					jsxImportSource: 'astro',
					// Note: disable `.md` support
					format: 'mdx',
					mdExtensions: [],
				};

				updateConfig({
					vite: {
						plugins: [
							{
								enforce: 'pre',
								...mdxPlugin(mdxPluginOpts),
								// Override transform to alter code before MDX compilation
								// ex. inject layouts
								async transform(code, id) {
									if (!id.endsWith('mdx')) return;

									// If user overrides our default YAML parser,
									// do not attempt to parse the `layout` via gray-matter
									if (!mdxOptions.frontmatterOptions?.parsers) {
										const frontmatter = getFrontmatter(code, id);
										if (frontmatter.layout) {
											const { layout, ...content } = frontmatter;
											code += `\nexport default async function({ children }) {\nconst Layout = (await import(${JSON.stringify(
												frontmatter.layout
											)})).default;\nreturn <Layout content={${JSON.stringify(
												content
											)}}>{children}</Layout> }`;
										}
									}

									const compiled = await mdxCompile(
										new VFile({ value: code, path: id }),
										mdxPluginOpts
									);

									return {
										code: String(compiled.value),
										map: compiled.map,
									};
								},
							},
							{
								name: '@astrojs/mdx-postprocess',
								// These transforms must happen *after* JSX runtime transformations
								transform(code, id) {
									if (!id.endsWith('.mdx')) return;
									const [, moduleExports] = parseESM(code);

									// This adds support for injected "page-ssr" scripts in MDX files.
									// TODO: This should only be happening on page entrypoints, not all imported MDX.
									// TODO: This code is copy-pasted across all Astro/Vite plugins that deal with page
									// entrypoints (.astro, .md, .mdx). This should be handled in some centralized place,
									// or otherwise refactored to not require copy-paste handling logic.
									code += `\nimport "${'astro:scripts/page-ssr.js'}";`;

									const { fileUrl, fileId } = getFileInfo(id, config);
									if (!moduleExports.includes('url')) {
										code += `\nexport const url = ${JSON.stringify(fileUrl)};`;
									}
									if (!moduleExports.includes('file')) {
										code += `\nexport const file = ${JSON.stringify(fileId)};`;
									}

									if (command === 'dev') {
										// TODO: decline HMR updates until we have a stable approach
										code += `\nif (import.meta.hot) {
											import.meta.hot.decline();
										}`;
									}
									return code;
								},
							},
						] as VitePlugin[],
					},
				});
			},
		},
	};
}
