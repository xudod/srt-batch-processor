import { Notice, requestUrl } from 'obsidian';

/**
 * JSON解析错误，包含原始响应内容
 */
export class JsonParseError extends Error {
    public originalResponse: string;

    constructor(message: string, originalResponse: string) {
        super(message);
        this.name = 'JsonParseError';
        this.originalResponse = originalResponse;
    }
}

/**
 * Herdsman API客户端
 * 负责与本地Herdsman服务通信（OpenAI兼容接口）
 */
export class HerdsmanClient {
    private baseUrl: string;
    private modelName: string;

    constructor(baseUrl: string, modelName: string) {
        this.baseUrl = baseUrl.replace(/\/$/, ''); // 移除末尾斜杠
        this.modelName = modelName;
    }

    /**
     * 更新配置
     */
    updateConfig(baseUrl: string, modelName: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.modelName = modelName;
    }

    /**
     * 获取已安装的模型列表
     * @returns 模型名称数组
     */
    async listModels(): Promise<string[]> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/v1/models`,
                method: 'GET',
                throw: false
            });

            if (response.status !== 200) {
                console.error('Failed to fetch models:', response.status);
                return [];
            }

            const data = response.json;
            if (data && data.data && Array.isArray(data.data)) {
                return data.data.map((model: any) => model.id);
            }
            
            return [];
        } catch (error) {
            console.error('Error fetching models from Herdsman:', error);
            return [];
        }
    }

    /**
     * 测试Herdsman服务连接
     * @returns 是否连接成功
     */
    async testConnection(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/v1/models`,
                method: 'GET',
                throw: false
            });
            
            return response.status === 200;
        } catch (error) {
            console.error('Herdsman connection test failed:', error);
            return false;
        }
    }

    /**
     * 调用大模型处理文本
     * @param systemPrompt 系统提示词
     * @param userContent 用户内容
     * @returns 大模型响应文本
     */
    async chat(
        systemPrompt: string, 
        userContent: string
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
            stream: false
        };

        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/v1/chat/completions`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                throw: false
            });

            if (response.status !== 200) {
                throw new Error(`Herdsman API error: ${response.status}`);
            }

            const data = response.json;
            return data.choices?.[0]?.message?.content || '';
        } catch (error) {
            console.error('Herdsman chat error:', error);
            throw new Error(`调用大模型失败: ${error.message}`);
        }
    }

    /**
     * 调用大模型处理文本并解析JSON响应
     * @param systemPrompt 系统提示词
     * @param content 文本内容
     * @returns 解析后的JSON响应
     */
    async processText(systemPrompt: string, content: string): Promise<any> {
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
            return parsed;
        } catch (error) {
            console.error('Failed to parse JSON response:', responseText);
            throw new JsonParseError(`大模型返回的JSON格式错误: ${error.message}`, responseText);
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