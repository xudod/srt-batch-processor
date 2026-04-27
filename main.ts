import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';

// 配置接口
interface SrtProcessorSettings {
	sourceFolder: string;
	outputFolder: string;
	promptTemplate: string;
	ollamaUrl: string;
	model: string;
	temperature: number;
	maxTokens: number;
	overwrite: boolean;
	availableModels: string[];
}

// 默认配置
const DEFAULT_SETTINGS: SrtProcessorSettings = {
	sourceFolder: '',
	outputFolder: '',
	promptTemplate: '请将以下字幕内容进行总结和整理，提取关键信息：\n\n{{content}}',
	ollamaUrl: 'http://localhost:11434',
	model: '',
	temperature: 0.7,
	maxTokens: 2000,
	overwrite: true,
	availableModels: []
}

export default class SrtProcessorPlugin extends Plugin {
	settings: SrtProcessorSettings;
	isProcessing: boolean = false;
	shouldStop: boolean = false;
	private statusBarItem: HTMLElement | null = null;  // 复用状态栏

	async onload() {
		await this.loadSettings();
		
		this.addRibbonIcon('bot', '批量处理SRT字幕', () => {
			this.processSrtFiles();
		});
		
		this.addCommand({
			id: 'process-srt-files',
			name: '批量处理SRT字幕文件',
			callback: () => {
				this.processSrtFiles();
			}
		});
		
		this.addSettingTab(new SrtProcessorSettingTab(this.app, this));
		await this.fetchAvailableModels();
	}
	
	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
	}
	
	async saveSettings() {
		await this.saveData(this.settings);
	}
	
	async fetchAvailableModels() {
		try {
			const response = await requestUrl({
				url: `${this.settings.ollamaUrl}/api/tags`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			});
			
			if (response.status === 200) {
				const data = response.json;
				if (data.models && Array.isArray(data.models)) {
					this.settings.availableModels = data.models.map((m: any) => m.name);
					if (!this.settings.model && this.settings.availableModels.length > 0) {
						this.settings.model = this.settings.availableModels[0];
						await this.saveSettings();
					}
					await this.saveSettings();
				}
			}
		} catch (error) {
			console.warn('无法连接Ollama服务:', error);
		}
	}
	
	async parseSrtFile(file: TFile): Promise<string> {
		const content = await this.app.vault.read(file);
		const lines = content.split(/\r?\n/);
		const textLines: string[] = [];
		
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line === '') continue;
			if (/^\d+$/.test(line)) continue;
			if (/^[\d\s]+$/.test(line) && line.match(/\d/g)?.length === line.length) continue;
			if (/^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}$/.test(line)) continue;
			
			textLines.push(line);
		}
		
		return textLines.join(' ');
	}
	
	buildPrompt(content: string): string {
		return this.settings.promptTemplate.replace(/\{\{content\}\}/g, content);
	}
	
	async callOllama(prompt: string): Promise<string> {
		const requestBody = {
			model: this.settings.model,
			prompt: prompt,
			stream: false,
			options: {
				temperature: this.settings.temperature,
				num_predict: this.settings.maxTokens
			}
		};
		
		console.log('调用Ollama，参数:', { 
			model: this.settings.model,
			maxTokens: this.settings.maxTokens,
			temperature: this.settings.temperature 
		});
		
		try {
			const response = await requestUrl({
				url: `${this.settings.ollamaUrl}/api/generate`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
				timeout: 600000  // 10分钟超时，适应大模型处理
			});
			
			if (this.shouldStop) {
				throw new Error('用户手动停止');
			}
			
			if (response.status === 200) {
				const data = response.json;
				return data.response || '没有返回内容';
			} else {
				throw new Error(`API返回状态码: ${response.status}`);
			}
		} catch (error) {
			console.error('Ollama调用失败:', error);
			throw new Error(`调用Ollama失败: ${error.message}`);
		}
	}
	
	async ensureFolder(folderPath: string): Promise<TFolder | null> {
		const normalizedPath = normalizePath(folderPath);
		const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (folder && folder instanceof TFolder) {
			return folder;
		}
		try {
			await this.app.vault.createFolder(normalizedPath);
			return this.app.vault.getAbstractFileByPath(normalizedPath) as TFolder;
		} catch (error) {
			console.error(`创建文件夹失败: ${folderPath}`, error);
			return null;
		}
	}
	
	async moveToFailFolder(file: TFile, sourceFolderPath: string) {
		const failFolderPath = normalizePath(`${sourceFolderPath}/fail`);
		await this.ensureFolder(failFolderPath);
		
		const newPath = normalizePath(`${failFolderPath}/${file.name}`);
		try {
			await this.app.vault.rename(file, newPath);
			console.log(`已移动失败文件: ${file.name}`);
		} catch (error) {
			console.error(`移动文件失败: ${file.name}`, error);
		}
	}
	
	// 修复：添加延迟重试机制，避免文件冲突
	async moveToSuccessFolder(file: TFile, sourceFolderPath: string) {
		const successFolderPath = normalizePath(`${sourceFolderPath}/success`);
		await this.ensureFolder(successFolderPath);
		
		let newFileName = file.name;
		let newPath = normalizePath(`${successFolderPath}/${newFileName}`);
		
		const existingFile = this.app.vault.getAbstractFileByPath(newPath);
		if (existingFile) {
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
			const nameWithoutExt = file.name.replace(/\.srt$/i, '');
			const extension = file.extension;
			newFileName = `${nameWithoutExt}_${timestamp}.${extension}`;
			newPath = normalizePath(`${successFolderPath}/${newFileName}`);
		}
		
		// 添加小延迟，确保文件系统同步
		await new Promise(resolve => setTimeout(resolve, 100));
		
		try {
			await this.app.vault.rename(file, newPath);
			console.log(`已移动成功文件: ${file.name} -> ${newFileName}`);
		} catch (error) {
			console.error(`移动文件失败: ${file.name}`, error);
			// 移动失败不影响主流程
		}
	}
	
	async saveMarkdownContent(originalFileName: string, content: string): Promise<void> {
		const outputFolder = normalizePath(this.settings.outputFolder);
		await this.ensureFolder(outputFolder);
		
		const mdFileName = originalFileName.replace(/\.srt$/i, '.md');
		const filePath = normalizePath(`${outputFolder}/${mdFileName}`);
		
		const existingFile = this.app.vault.getAbstractFileByPath(filePath);
		if (existingFile && !this.settings.overwrite) {
			console.log(`文件已存在且不覆盖: ${mdFileName}`);
			return;
		}
		
		if (existingFile && existingFile instanceof TFile) {
			await this.app.vault.modify(existingFile, content);
		} else {
			await this.app.vault.create(filePath, content);
		}
	}
	
	async stopProcessing() {
		if (this.isProcessing) {
			this.shouldStop = true;
			new Notice('正在停止处理，请稍候...');
		} else {
			new Notice('当前没有正在进行的处理任务');
		}
	}
	
	// 更新状态栏（复用同一个元素）
	updateStatusBar(text: string, isError: boolean = false) {
		if (!this.statusBarItem) {
			this.statusBarItem = this.addStatusBarItem();
		}
		this.statusBarItem.setText(text);
		if (isError) {
			this.statusBarItem.style.color = 'var(--text-error)';
		} else {
			this.statusBarItem.style.color = '';
		}
	}
	
	clearStatusBar() {
		if (this.statusBarItem) {
			this.statusBarItem.remove();
			this.statusBarItem = null;
		}
	}
	
	async processSrtFiles() {
		if (this.isProcessing) {
			new Notice('已有处理任务正在进行中，请稍后...');
			return;
		}
		
		this.shouldStop = false;
		this.clearStatusBar();
		
		if (!this.settings.sourceFolder) {
			new Notice('请先在插件设置中配置源文件夹路径');
			return;
		}
		if (!this.settings.outputFolder) {
			new Notice('请先在插件设置中配置输出文件夹路径');
			return;
		}
		if (!this.settings.model) {
			new Notice('请先在插件设置中选择Ollama模型');
			return;
		}
		
		const sourceFolderPath = normalizePath(this.settings.sourceFolder);
		const sourceFolder = this.app.vault.getAbstractFileByPath(sourceFolderPath);
		if (!sourceFolder || !(sourceFolder instanceof TFolder)) {
			new Notice(`源文件夹不存在: ${this.settings.sourceFolder}`);
			return;
		}
		
		const srtFiles = sourceFolder.children.filter(child => 
			child instanceof TFile && child.extension.toLowerCase() === 'srt'
		) as TFile[];
		
		if (srtFiles.length === 0) {
			new Notice('源文件夹中没有找到SRT字幕文件');
			return;
		}
		
		this.isProcessing = true;
		let successCount = 0;
		let failCount = 0;
		let stopRequested = false;
		
		new Notice(`开始处理 ${srtFiles.length} 个SRT文件`);
		
		for (let i = 0; i < srtFiles.length; i++) {
			if (this.shouldStop) {
				stopRequested = true;
				new Notice(`用户已停止处理，已完成 ${i} 个文件`);
				break;
			}
			
			const file = srtFiles[i];
			const currentNumber = i + 1;
			
			this.updateStatusBar(`正在处理: ${file.name} (${currentNumber}/${srtFiles.length})`);
			
			try {
				console.log(`开始处理文件 ${currentNumber}/${srtFiles.length}: ${file.name}`);
				
				const textContent = await this.parseSrtFile(file);
				if (!textContent || textContent.trim().length === 0) {
					throw new Error('文件内容为空');
				}
				
				console.log(`文件解析完成，内容长度: ${textContent.length} 字符`);
				
				if (this.shouldStop) break;
				
				const prompt = this.buildPrompt(textContent);
				console.log(`开始调用Ollama模型: ${this.settings.model}`);
				
				const aiResponse = await this.callOllama(prompt);
				
				console.log(`Ollama返回完成，响应长度: ${aiResponse.length} 字符`);
				
				if (this.shouldStop) break;
				
				await this.saveMarkdownContent(file.name, aiResponse);
				await this.moveToSuccessFolder(file, sourceFolderPath);
				
				successCount++;
				this.updateStatusBar(`✅ 完成: ${file.name} (${currentNumber}/${srtFiles.length})`);
				new Notice(`已处理: ${file.name} (${currentNumber}/${srtFiles.length})`);
				
			} catch (error) {
				console.error(`处理文件失败: ${file.name}`, error);
				failCount++;
				this.updateStatusBar(`❌ 失败: ${file.name} (${currentNumber}/${srtFiles.length})`, true);
				new Notice(`处理失败: ${file.name} - ${error.message}`);
				
				try {
					await this.moveToFailFolder(file, sourceFolderPath);
				} catch (moveError) {
					console.error(`移动失败文件出错: ${file.name}`, moveError);
				}
			}
			
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		
		this.isProcessing = false;
		this.shouldStop = false;
		this.clearStatusBar();
		
		let summaryMsg = stopRequested 
			? `已停止处理！\n成功: ${successCount} 个\n失败: ${failCount} 个`
			: `处理完成！\n成功: ${successCount} 个\n失败: ${failCount} 个`;
		
		if (failCount > 0) {
			summaryMsg += `\n失败文件已移动到 ${this.settings.sourceFolder}/fail/`;
		}
		if (successCount > 0) {
			summaryMsg += `\n成功文件已移动到 ${this.settings.sourceFolder}/success/`;
		}
		new Notice(summaryMsg);
	}
	
	onunload() {
		this.isProcessing = false;
		this.shouldStop = false;
		this.clearStatusBar();
	}
}

// 设置选项卡（保持原样，只修改最大Token的描述）
class SrtProcessorSettingTab extends PluginSettingTab {
	plugin: SrtProcessorPlugin;
	
	constructor(app: App, plugin: SrtProcessorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	
	async display(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		
		containerEl.createEl('h2', { text: 'SRT批量处理器设置' });
		
		// 控制面板
		const controlDiv = containerEl.createEl('div', { 
			attr: { style: 'background: var(--background-secondary); padding: 12px; border-radius: 6px; margin-bottom: 20px;' } 
		});
		controlDiv.createEl('h3', { text: '控制面板' });
		
		new Setting(controlDiv)
			.setName('停止处理')
			.setDesc('立即停止当前正在进行的批量处理任务')
			.addButton(button => button
				.setButtonText('停止处理')
				.setWarning()
				.onClick(async () => {
					await this.plugin.stopProcessing();
				}));
		
		containerEl.createEl('hr');
		
		new Setting(containerEl)
			.setName('源文件夹路径')
			.setDesc('存放SRT字幕文件的文件夹路径（相对于仓库根目录）')
			.addText(text => text
				.setPlaceholder('例如: 字幕/待处理')
				.setValue(this.plugin.settings.sourceFolder)
				.onChange(async (value) => {
					this.plugin.settings.sourceFolder = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('输出文件夹路径')
			.setDesc('生成MD文档的保存文件夹（相对于仓库根目录）')
			.addText(text => text
				.setPlaceholder('例如: 字幕/处理结果')
				.setValue(this.plugin.settings.outputFolder)
				.onChange(async (value) => {
					this.plugin.settings.outputFolder = value;
					await this.plugin.saveSettings();
				}));
		
		containerEl.createEl('h3', { text: 'Ollama配置' });
		
		new Setting(containerEl)
			.setName('Ollama服务地址')
			.setDesc('本地Ollama服务的API地址')
			.addText(text => text
				.setPlaceholder('http://localhost:11434')
				.setValue(this.plugin.settings.ollamaUrl)
				.onChange(async (value) => {
					this.plugin.settings.ollamaUrl = value;
					await this.plugin.saveSettings();
					await this.plugin.fetchAvailableModels();
					this.display();
				}));
		
		new Setting(containerEl)
			.setName('刷新模型列表')
			.setDesc('从Ollama服务获取可用的模型')
			.addButton(button => button
				.setButtonText('刷新')
				.onClick(async () => {
					await this.plugin.fetchAvailableModels();
					this.display();
					new Notice('模型列表已刷新');
				}));
		
		if (this.plugin.settings.availableModels.length > 0) {
			new Setting(containerEl)
				.setName('选择模型')
				.setDesc('选择要使用的Ollama模型')
				.addDropdown(dropdown => {
					this.plugin.settings.availableModels.forEach(model => {
						dropdown.addOption(model, model);
					});
					dropdown.setValue(this.plugin.settings.model || this.plugin.settings.availableModels[0]);
					dropdown.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					});
				});
		} else {
			containerEl.createEl('div', { 
				text: '⚠️ 未检测到模型，请确认Ollama服务已启动且已安装模型', 
				attr: { style: 'color: var(--text-muted); margin: 10px 0;' } 
			});
		}
		
		new Setting(containerEl)
			.setName('温度')
			.setDesc('控制输出的随机性（0-1），值越低越严格遵循指令')
			.addSlider(slider => slider
				.setLimits(0, 1, 0.05)
				.setValue(this.plugin.settings.temperature)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.temperature = value;
					await this.plugin.saveSettings();
				}))
			.addText(text => text
				.setValue(this.plugin.settings.temperature.toString())
				.onChange(async (value) => {
					const num = parseFloat(value);
					if (!isNaN(num) && num >= 0 && num <= 1) {
						this.plugin.settings.temperature = num;
						await this.plugin.saveSettings();
					}
				}));
		
		new Setting(containerEl)
			.setName('最大输出长度')
			.setDesc('模型输出的最大长度（单位：tokens），约等于中文字符数 × 1.5')
			.addText(text => text
				.setPlaceholder('2000')
				.setValue(this.plugin.settings.maxTokens.toString())
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.maxTokens = num;
						await this.plugin.saveSettings();
					}
				}));
		
		containerEl.createEl('h3', { text: '提示词配置' });
		
		new Setting(containerEl)
			.setName('提示词模板')
			.setDesc('使用 {{content}} 作为字幕内容的占位符')
			.addTextArea(text => text
				.setPlaceholder('请将以下字幕内容进行总结和整理：\n\n{{content}}')
				.setValue(this.plugin.settings.promptTemplate)
				.onChange(async (value) => {
					this.plugin.settings.promptTemplate = value;
					await this.plugin.saveSettings();
				}))
			.then(setting => {
				setting.controlEl.style.width = '100%';
				(setting.controlEl.querySelector('textarea') as HTMLTextAreaElement)?.setAttribute('rows', '8');
			});
		
		new Setting(containerEl)
			.setName('覆盖已有文件')
			.setDesc('如果输出文件夹中已存在同名md文件，是否覆盖')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.overwrite)
				.onChange(async (value) => {
					this.plugin.settings.overwrite = value;
					await this.plugin.saveSettings();
				}));
		
		containerEl.createEl('hr');
		
		containerEl.createEl('h3', { text: '使用说明' });
		const usageDiv = containerEl.createEl('div', { attr: { style: 'background: var(--background-secondary); padding: 12px; border-radius: 6px;' } });
		usageDiv.createEl('p', { text: '1. 配置源文件夹和输出文件夹路径' });
		usageDiv.createEl('p', { text: '2. 确保Ollama服务已启动，点击"刷新模型列表"获取可用模型' });
		usageDiv.createEl('p', { text: '3. 编写提示词模板，使用 {{content}} 代表字幕文本' });
		usageDiv.createEl('p', { text: '4. 运行命令"批量处理SRT字幕文件"或点击左侧机器人图标开始处理' });
		usageDiv.createEl('p', { text: '5. 处理过程中可随时点击设置中的"停止处理"按钮停止任务' });
		usageDiv.createEl('p', { text: '6. 成功文件会移动到源文件夹下的 success 文件夹，失败文件移动到 fail 文件夹' });
		usageDiv.createEl('p', { text: '⚠️ 注意：处理中请查看开发者控制台（Ctrl+Shift+I）了解详细进度' });
	}
}