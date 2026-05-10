import { TFile, Vault } from 'obsidian';

/**
 * SRT字幕解析器
 * 负责读取SRT文件并提取纯文本内容
 */
export class SubtitleExtractor {
    
    /**
     * 从SRT文件中提取纯文本内容
     * @param content SRT文件内容
     * @returns 纯文本内容（过滤掉时间轴和序号，保留空行）
     */
    static extractPureText(content: string): string {
        const lines = content.split(/\r?\n/);
        const textLines: string[] = [];
        
        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            
            // 跳过空行
            if (line === '') {
                textLines.push('');
                i++;
                continue;
            }
            
            // 检查是否是序号（纯数字）
            if (/^\d+$/.test(line)) {
                i++;
                continue;
            }
            
            // 检查是否是时间轴行（包含 --&gt; 或 -->）
            if (line.includes('-->') || line.includes('--&gt;')) {
                i++;
                continue;
            }
            
            // 不是序号也不是时间轴，就是字幕文本
            textLines.push(line);
            i++;
        }
        
        // 合并文本，保持段落结构
        return textLines.join('\n');
    }
    
    /**
     * 从SRT文件中提取文本，并保留段落信息
     * @param content SRT文件内容
     * @returns 文本段落数组
     */
    static extractTextWithParagraphs(content: string): string[] {
        const lines = content.split(/\r?\n/);
        const paragraphs: string[] = [];
        let currentParagraph: string[] = [];
        
        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            
            // 跳过序号和时间轴
            if (/^\d+$/.test(line)) {
                i++;
                continue;
            }
            
            if (line.includes('-->') || line.includes('--&gt;')) {
                i++;
                continue;
            }
            
            // 空行表示段落结束
            if (line === '') {
                if (currentParagraph.length > 0) {
                    paragraphs.push(currentParagraph.join(' '));
                    currentParagraph = [];
                }
                i++;
                continue;
            }
            
            // 添加文本行
            currentParagraph.push(line);
            i++;
        }
        
        // 添加最后一个段落
        if (currentParagraph.length > 0) {
            paragraphs.push(currentParagraph.join(' '));
        }
        
        return paragraphs;
    }
    
    /**
     * 读取并解析SRT文件
     * @param vault Obsidian Vault实例
     * @param file SRT文件对象
     * @returns 纯文本内容
     */
    static async readSRTFile(vault: Vault, file: TFile): Promise<string> {
        const content = await vault.read(file);
        return this.extractPureText(content);
    }
    
    /**
     * 计算文本中的中文字符数
     * @param text 文本内容
     * @returns 中文字符数量
     */
    static countChineseChars(text: string): number {
        const chineseRegex = /[\u4e00-\u9fa5]/g;
        const matches = text.match(chineseRegex);
        return matches ? matches.length : 0;
    }
    
    /**
     * 按中文字符数分片文本
     * @param text 文本内容
     * @param maxChineseChars 最大中文字符数
     * @returns 分片后的文本数组
     */
    static splitByChineseChars(text: string, maxChineseChars: number): string[] {
        if (this.countChineseChars(text) <= maxChineseChars) {
            return [text];
        }
        
        const chunks: string[] = [];
        let currentChunk = '';
        let currentChineseCount = 0;
        
        // 按句子或段落分片，尽量保持语义完整
        const paragraphs = text.split(/\n+/);
        
        for (const paragraph of paragraphs) {
            const paragraphChineseCount = this.countChineseChars(paragraph);
            
            if (currentChineseCount + paragraphChineseCount <= maxChineseChars) {
                // 添加到当前分片
                if (currentChunk) {
                    currentChunk += '\n\n' + paragraph;
                } else {
                    currentChunk = paragraph;
                }
                currentChineseCount += paragraphChineseCount;
            } else {
                // 当前分片已满，保存并开始新分片
                if (currentChunk) {
                    chunks.push(currentChunk);
                }
                
                // 如果单个段落太长，需要进一步分割
                if (paragraphChineseCount > maxChineseChars) {
                    const subChunks = this.splitLongParagraph(paragraph, maxChineseChars);
                    chunks.push(...subChunks.slice(0, -1));
                    currentChunk = subChunks[subChunks.length - 1];
                    currentChineseCount = this.countChineseChars(currentChunk);
                } else {
                    currentChunk = paragraph;
                    currentChineseCount = paragraphChineseCount;
                }
            }
        }
        
        // 添加最后一个分片
        if (currentChunk) {
            chunks.push(currentChunk);
        }
        
        return chunks;
    }
    
    /**
     * 分割过长的段落
     * @param paragraph 段落文本
     * @param maxChineseChars 最大中文字符数
     * @returns 分割后的文本数组
     */
    private static splitLongParagraph(paragraph: string, maxChineseChars: number): string[] {
        const chunks: string[] = [];
        let currentChunk = '';
        let currentCount = 0;
        
        // 按句子分割（句号、问号、感叹号、分号等）
        const sentences = paragraph.split(/([。？！；])/);
        
        for (let i = 0; i < sentences.length; i += 2) {
            const sentence = sentences[i] + (sentences[i + 1] || '');
            const sentenceChineseCount = this.countChineseChars(sentence);
            
            if (currentCount + sentenceChineseCount <= maxChineseChars) {
                currentChunk += sentence;
                currentCount += sentenceChineseCount;
            } else {
                if (currentChunk) {
                    chunks.push(currentChunk);
                }
                currentChunk = sentence;
                currentCount = sentenceChineseCount;
            }
        }
        
        if (currentChunk) {
            chunks.push(currentChunk);
        }
        
        return chunks;
    }
    
    /**
     * 验证是否为有效的SRT文件
     * @param filePath 文件路径
     * @returns 是否为SRT文件
     */
    static isValidSRTFile(filePath: string): boolean {
        return filePath.toLowerCase().endsWith('.srt');
    }
    
    /**
     * 获取文件名（不含扩展名）
     * @param filePath 文件路径
     * @returns 文件名
     */
    static getFileNameWithoutExtension(filePath: string): string {
        const baseName = filePath.split('/').pop() || filePath;
        const lastDotIndex = baseName.lastIndexOf('.');
        return lastDotIndex > 0 ? baseName.substring(0, lastDotIndex) : baseName;
    }
}