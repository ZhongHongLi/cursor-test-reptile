const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const winston = require("winston");
const cron = require("node-cron");
// 添加simple-git库
const simpleGit = require("simple-git");
/**
 * 配置日志记录器
 *
 * @type {winston.Logger}
 */
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "news_crawler.log" }),
  ],
});

/**
 * 将新闻内容提交到GitHub仓库
 *
 * @async
 * @param {string} filePath - 需要提交的文件路径
 * @returns {Promise<boolean>} - 提交成功返回true
 */
async function commitToGitHub(filePath) {
  try {
    logger.info("准备提交文件到GitHub...");

    // 初始化Git对象，指定仓库路径（当前目录）
    const git = simpleGit();

    // 检查Git状态
    const status = await git.status();

    // 确认我们有文件要提交
    if (
      !status.modified.includes(filePath) &&
      !status.not_added.includes(filePath)
    ) {
      logger.warn(`文件 ${filePath} 没有变更，无需提交`);
      return false;
    }

    // 构建提交信息
    const now = new Date();
    const commitMsg = `更新每日新闻 ${now.toISOString().split("T")[0]}`;

    // 添加、提交并推送文件
    await git.add(filePath);
    await git.commit(commitMsg);
    await git.push("origin", "main"); // 假设你使用main分支，如果是master请修改

    logger.info(`已成功提交和推送文件 ${filePath} 到GitHub`);
    return true;
  } catch (error) {
    logger.error(`GitHub提交失败: ${error.message}`);
    return false;
  }
}

/**
 * 新闻爬虫类
 *
 * @class
 */
class NewsCrawler {
  /**
   * 创建爬虫实例
   *
   * @param {string} url - 目标网站URL
   */
  constructor(url) {
    this.url = url;
    this.headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    };
  }

  /**
   * 获取网页内容
   *
   * @async
   * @returns {Promise<string>} - HTML内容
   */
  async fetchPage() {
    try {
      logger.info(`正在获取页面: ${this.url}`);
      const response = await axios.get(this.url, {
        headers: this.headers,
        timeout: 10000, // 10秒超时
      });
      logger.info(`成功获取页面: ${this.url}, 状态码: ${response.status}`);
      return response.data;
    } catch (error) {
      logger.error(`获取页面失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 解析新闻内容
   *
   * @param {string} html - HTML内容
   * @returns {Array<Object>} - 新闻对象数组
   */
  parseNews(html) {
    try {
      logger.info(`开始解析新闻内容`);
      const $ = cheerio.load(html);
      const newsItems = [];

      // 尝试不同的选择器来找到新闻条目
      // 新浪新闻
      if (this.url.includes("sina.com.cn")) {
        // 尝试获取热门新闻
        $(".news-item, .ty-card-type1, .ty-card-type2").each((i, el) => {
          try {
            const $el = $(el);
            const title =
              $el.find("h2, .ty-card-tt, .news-title").text().trim() ||
              $el.find("a").first().text().trim();
            const link = $el.find("a").attr("href");

            if (title && link) {
              const fullLink = link.startsWith("http")
                ? link
                : new URL(link, this.url).href;
              newsItems.push({
                title: title,
                link: fullLink,
                summary: "热门新闻",
                crawl_time: new Date().toISOString(),
                source: "新浪新闻",
              });
            }
          } catch (e) {
            logger.warn(`解析新闻项时出错: ${e.message}`);
          }
        });

        // 尝试获取微博热搜
        $(".list_a li, .data-list li").each((i, el) => {
          try {
            const $el = $(el);
            const title = $el.find("a, span").first().text().trim();
            const link = $el.find("a").attr("href");

            if (title && link) {
              const fullLink = link.startsWith("http")
                ? link
                : new URL(link, this.url).href;
              newsItems.push({
                title: title,
                link: fullLink,
                summary: "热榜新闻，无摘要",
                crawl_time: new Date().toISOString(),
                source: "新浪微博热搜",
              });
            }
          } catch (e) {
            logger.warn(`解析热搜项时出错: ${e.message}`);
          }
        });
      }

      // 网易新闻
      else if (this.url.includes("163.com")) {
        $(".news_title, .data_row, .news_item").each((i, el) => {
          try {
            const $el = $(el);
            const title = $el.find("h3, .title, a").first().text().trim();
            const link = $el.find("a").attr("href");

            if (title && link) {
              const fullLink = link.startsWith("http")
                ? link
                : new URL(link, this.url).href;
              newsItems.push({
                title: title,
                link: fullLink,
                summary: "网易新闻，无摘要",
                crawl_time: new Date().toISOString(),
                source: "网易新闻",
              });
            }
          } catch (e) {
            logger.warn(`解析网易新闻项时出错: ${e.message}`);
          }
        });
      }

      // 通用爬取策略，尝试查找明显的标题和链接
      if (newsItems.length === 0) {
        $("a").each((i, el) => {
          const $el = $(el);
          const href = $el.attr("href");
          const text = $el.text().trim();

          // 过滤有效的新闻链接：文本长度适中且包含链接
          if (
            text &&
            href &&
            text.length > 10 &&
            text.length < 100 &&
            !/^(javascript|mailto|tel):/.test(href)
          ) {
            try {
              const fullLink = href.startsWith("http")
                ? href
                : new URL(href, this.url).href;
              newsItems.push({
                title: text,
                link: fullLink,
                summary: "通用爬取，无摘要",
                crawl_time: new Date().toISOString(),
                source: new URL(this.url).hostname,
              });
            } catch (e) {
              // 忽略无效URL
            }
          }
        });
      }

      // 去重
      const uniqueNews = Array.from(
        new Map(newsItems.map((item) => [item.title, item])).values()
      );

      logger.info(`成功解析到 ${uniqueNews.length} 条新闻`);
      return uniqueNews;
    } catch (error) {
      logger.error(`解析新闻内容失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 将新闻保存为Markdown文件
   *
   * @async
   * @param {Array<Object>} newsItems - 新闻条目列表
   * @param {string} [filename] - 文件名，默认为当前日期.md
   * @returns {Promise<boolean>} - 保存成功返回true
   */
  async saveToMarkdown(newsItems, filename = null) {
    if (!newsItems || newsItems.length === 0) {
      logger.warn("没有新闻数据可保存");
      return false;
    }

    if (!filename) {
      // 按年月日格式创建文件名
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      filename = `${year}${month}${day}.md`;
    }

    try {
      // 创建Markdown内容
      let mdContent = `# 每日新闻摘要 ${new Date().toLocaleDateString(
        "zh-CN"
      )}\n\n`;

      // 按新闻来源分组
      const newsBySource = {};
      newsItems.forEach((item) => {
        if (!newsBySource[item.source]) {
          newsBySource[item.source] = [];
        }
        newsBySource[item.source].push(item);
      });

      // 为每个来源创建一个章节
      for (const [source, items] of Object.entries(newsBySource)) {
        mdContent += `## ${source}\n\n`;

        // 为每一项新闻创建表格行
        mdContent += `| 标题 | 链接 |\n`;
        mdContent += `| ---- | ---- |\n`;

        items.forEach((item) => {
          // 处理标题中可能包含的|符号，防止破坏表格结构
          const safeTitle = item.title.replace(/\|/g, "\\|");
          mdContent += `| ${safeTitle} | [链接](${item.link}) |\n`;
        });

        mdContent += `\n`;
      }

      // 添加爬取时间信息
      mdContent += `\n> 爬取时间: ${new Date().toLocaleString("zh-CN")}\n`;

      // 写入文件
      fs.writeFileSync(filename, mdContent, "utf8");
      logger.info(
        `已保存 ${newsItems.length} 条新闻到 Markdown 文件 ${filename}`
      );
      return true;
    } catch (error) {
      logger.error(`保存Markdown文件失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 保存为CSV文件
   *
   * @async
   * @param {Array<Object>} newsItems - 新闻条目
   * @param {string} [filename] - 文件名
   * @returns {Promise<boolean>} - 成功返回true
   */
  async saveToCsv(newsItems, filename = null) {
    if (!newsItems || newsItems.length === 0) {
      logger.warn("没有新闻数据可保存到CSV");
      return false;
    }

    if (!filename) {
      const date = new Date().toISOString().split("T")[0].replace(/-/g, "");
      filename = `news_${date}.csv`;
    }

    try {
      // 手动创建CSV内容 (带BOM头以支持Excel中文)
      const BOM = "\uFEFF";
      let csvContent = BOM + "标题,链接,摘要,爬取时间,来源\n";

      newsItems.forEach((item) => {
        // 处理CSV特殊字符
        const title = item.title.replace(/"/g, '""').replace(/,/g, "，");
        const link = item.link;
        const summary = (item.summary || "")
          .replace(/"/g, '""')
          .replace(/,/g, "，");
        const time = item.crawl_time;
        const source = item.source;

        csvContent += `"${title}","${link}","${summary}","${time}","${source}"\n`;
      });

      fs.writeFileSync(filename, csvContent, "utf8");
      logger.info(`已保存 ${newsItems.length} 条新闻到 CSV 文件 ${filename}`);
      return true;
    } catch (error) {
      logger.error(`保存CSV文件失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 运行爬虫
   *
   * @async
   * @param {string} [filename] - 保存的文件名
   * @param {boolean} [debug=true] - 是否启用调试模式
   * @returns {Promise<Array<Object>>} - 爬取的新闻列表
   */
  async run(filename = null, debug = true) {
    try {
      const html = await this.fetchPage();

      if (debug) {
        fs.writeFileSync("debug_html.html", html);
        logger.debug("已保存原始HTML到debug_html.html");
      }

      const newsItems = this.parseNews(html);

      if (newsItems.length > 0) {
        logger.info(`成功解析到 ${newsItems.length} 条新闻`);

        // 保存为Markdown
        await this.saveToMarkdown(newsItems, filename);

        // 也保存CSV格式
        // await this.saveToCsv(newsItems, filename ? `${filename}.csv` : null);
      } else {
        logger.warn(`从 ${this.url} 没有解析到任何新闻`);
      }

      return newsItems;
    } catch (error) {
      logger.error(`爬虫运行失败: ${error.message}`);
      return [];
    }
  }
}

/**
 * 每天执行一次爬虫任务
 */
function setupDailyTask() {
  // 设置每天早上8点执行
  cron.schedule("0 8 * * *", async () => {
    logger.info("开始执行每日爬虫任务");
    await main();
    logger.info("每日爬虫任务完成");
  });

  logger.info("已设置每日爬虫任务，将在每天早上8点执行");
}

/**
 * 主函数
 *
 * @async
 */
async function main() {
  // 中国主流新闻网站
  const newsSites = [
    "https://news.sina.com.cn/",
    "https://news.163.com/",
    "https://news.qq.com/",
    "https://www.sohu.com/c/8/",
    "https://www.thepaper.cn/",
  ];

  const allNews = [];

  for (const site of newsSites) {
    try {
      logger.info(`开始爬取: ${site}`);
      const crawler = new NewsCrawler(site);
      const news = await crawler.run();

      allNews.push(...news);
      logger.info(`成功爬取 ${news.length} 条新闻`);

      // 休息一段时间，避免请求过于频繁
      const sleepTime = 3000 + Math.random() * 5000;
      logger.info(`等待 ${Math.round(sleepTime / 1000)} 秒后继续下一个网站`);
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    } catch (error) {
      logger.error(`处理 ${site} 时出错: ${error.message}`);
    }
  }

  // 将所有新闻保存到一个总Markdown文件
  if (allNews.length > 0) {
    // 按年月日格式创建文件名
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const mdFilename = `${year}${month}${day}.md`;

    // 创建爬虫实例用于保存
    const dummyCrawler = new NewsCrawler("https://example.com");
    await dummyCrawler.saveToMarkdown(allNews, mdFilename);

    logger.info(
      `已保存总计 ${allNews.length} 条新闻到 Markdown 文件 ${mdFilename}`
    );
    // 提交到GitHub
    await commitToGitHub(mdFilename);
  }
}

// 当文件直接运行时
if (require.main === module) {
  // 检查命令行参数
  const args = process.argv.slice(2);
  if (args.includes("--daemon") || args.includes("-d")) {
    // 作为守护进程运行，设置定时任务
    setupDailyTask();
  } else {
    // 立即执行一次爬虫
    main().catch((error) => {
      logger.error(`程序执行失败: ${error.message}`);
      process.exit(1);
    });
  }
}

// 导出 NewsCrawler 类以便其他模块使用
module.exports = { NewsCrawler, setupDailyTask, main };
