import { Notice, requestUrl } from 'obsidian';

/**
 * Herdsman API客户端
 * 负责与本地Herdsman服务通信（OpenAI兼容）
 */
export class HerdsmanClient {
    private baseUrl: string;
    private modelName: string;

    constructor(baseUrl: string, modelName: string) {
        this.baseUrl = this.normalizeBaseUrl(baseUrl);
        this.modelName = modelName;
    }

    /**
     * 更新配置
     */
    updateConfig(baseUrl: string, modelName: string) {
        this.baseUrl = this.normalizeBaseUrl(baseUrl);
        this.modelName = modelName;
    }

    /**
     * 标准化基础URL
     * 移除末尾斜杠和可能的 /v1 后缀，确保API调用时正确拼接路径
     */
    private normalizeBaseUrl(baseUrl: string): string {
        let normalized = baseUrl.replace(/\/$/, ''); // 移除末尾斜杠
        // 如果URL末尾是 /v1，也移除它，因为我们在API调用时会添加
        normalized = normalized.replace(/\/v1$/, '');
        return normalized;
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
}
