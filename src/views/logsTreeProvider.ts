import * as vscode from 'vscode';

const MAX_ENTRIES = 200;

export class LogsTreeProvider implements vscode.TreeDataProvider<string> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly entries: string[] = [];

	log(message: string): void {
		const timestamp = new Date().toLocaleTimeString();
		this.entries.unshift(`[${timestamp}] ${message}`);
		this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: string): vscode.TreeItem {
		return new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.None);
	}

	getChildren(element?: string): string[] {
		if (element) {
			return [];
		}
		return this.entries.length > 0 ? this.entries : ['No log entries yet'];
	}
}
