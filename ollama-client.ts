import { Notice, requestUrl } from 'obsidian';
import { ChunkResponse } from './types';

/**
 * Ollama API客户端
 * 负责与本地Ollama服务通信
 */
export class OllamaClient {
    private baseUrl: string;
    private modelName: string;
    private temperature: number;
    private topP: number;

    constructor(baseUrl: string, modelName: string, temperature: number, topP: number) {
        this.baseUrl = baseUrl.replace(/\/$/, ''); // 移除末尾斜杠
        this.modelName = modelName;
        this.temperature = temperature;
        this.topP = topP;
    }

    /**
     * 更新配置
     */
    updateConfig(baseUrl: string, modelName: string, temperature: number, topP: number) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.modelName = modelName;
        this.temperature = temperature;
        this.topP = topP;
    }

    /**
     * 获取已安装的模型列表
     * @returns 模型名称数组
     */
    async listModels(): Promise<string[]> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/tags`,
                method: 'GET',
                throw: false
            });

            if (response.status !== 200) {
                console.error('Failed to fetch models:', response.status);
                return [];
            }

            const data = response.json;
            if (data && data.models && Array.isArray(data.models)) {
                return data.models.map((model: any) => model.name);
            }
            
            return [];
        } catch (error) {
            console.error('Error fetching models from Ollama:', error);
            return [];
        }
    }

    /**
     * 测试Ollama服务连接
     * @returns 是否连接成功
     */
    async testConnection(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/tags`,
                method: 'GET',
                throw: false
            });
            
            return response.status === 200;
        } catch (error) {
            console.error('Ollama connection test failed:', error);
            return false;
        }
    }

    /**
     * 调用大模型处理文本（支持流式输出）
     * @param systemPrompt 系统提示词
     * @param userContent 用户内容
     * @param onChunk 流式输出回调（可选）
     * @returns 大模型响应文本
     */
    async chat(
        systemPrompt: string, 
        userContent: string, 
        onChunk?: (chunk: string) => void
    ): Promise<string> {
        const fullPrompt = systemPrompt.replace('{{content}}', userContent);
        
        const body = {
            model: this.modelName,
            messages: [
                {
                    role: 'user',
                    content: fullPrompt
                }
            ],
            stream: !!onChunk,
            options: {
                temperature: this.temperature,
                top_p: this.topP
            }
        };

        try {
            if (onChunk) {
                // 流式输出模式
                return await this.streamChat(body, onChunk);
            } else {
                // 非流式模式
                const response = await requestUrl({
                    url: `${this.baseUrl}/api/chat`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(body),
                    throw: false
                });

                if (response.status !== 200) {
                    throw new Error(`Ollama API error: ${response.status}`);
                }

                const data = response.json;
                return data.message?.content || '';
            }
        } catch (error) {
            console.error('Ollama chat error:', error);
            throw new Error(`调用大模型失败: ${error.message}`);
        }
    }

    /**
     * 流式聊天处理
     */
    private async streamChat(body: any, onChunk: (chunk: string) => void): Promise<string> {
        // 注意：Obsidian的requestUrl不直接支持流式响应
        // 这里使用非流式模式作为替代
        // 如果需要真正的流式，可能需要使用fetch API
        console.warn('Obsidian环境限制，使用非流式模式代替流式输出');
        
        const response = await requestUrl({
            url: `${this.baseUrl}/api/chat`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ...body, stream: false }),
            throw: false
        });

        if (response.status !== 200) {
            throw new Error(`Ollama API error: ${response.status}`);
        }

        const data = response.json;
        const content = data.message?.content || '';
        
        // 模拟流式输出，一次性输出全部内容
        onChunk(content);
        
        return content;
    }

    /**
     * 调用大模型处理分片，并解析JSON响应
     * @param systemPrompt 系统提示词
     * @param content 文本内容
     * @returns 解析后的JSON响应
     */
    async processChunk(systemPrompt: string, content: string): Promise<ChunkResponse> {
        const responseText = await this.chat(systemPrompt, content);
        
        try {
            // 尝试解析JSON响应
            // 处理可能包含markdown代码块的情况
            let jsonText = responseText.trim();
            
            // 移除markdown代码块标记
            if (jsonText.startsWith('```json')) {
                jsonText = jsonText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
            } else if (jsonText.startsWith('```')) {
                jsonText = jsonText.replace(/^```\n?/, '').replace(/\n?```$/, '');
            }
            
            const parsed = JSON.parse(jsonText);
            
            // 验证必需字段
            return {
                自然分段: parsed.自然分段 || '',
                分段总结: parsed.分段总结 || '',
                关键字: Array.isArray(parsed.关键字) ? parsed.关键字 : [],
                应并入下一段: parsed.应并入下一段 || ''
            };
        } catch (error) {
            console.error('Failed to parse JSON response:', responseText);
            throw new Error(`大模型返回的JSON格式错误: ${error.message}`);
        }
    }

    /**
     * 调用大模型进行整体概括
     * @param summaryPrompt 概括提示词
     * @param summaries 分段总结列表
     * @returns 整体概括文本
     */
    async generateOverallSummary(summaryPrompt: string, summaries: string[]): Promise<string> {
        const summariesText = summaries.map((s, i) => `第${i + 1}部分总结：\n${s}`).join('\n\n');
        const fullPrompt = summaryPrompt.replace('{{summaries}}', summariesText);
        
        const response = await this.chat(fullPrompt, '请根据以上分段总结生成整体概括');
        
        return response.trim();
    }
}