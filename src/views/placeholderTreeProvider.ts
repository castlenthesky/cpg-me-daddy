import * as vscode from 'vscode';

export class PlaceholderTreeProvider implements vscode.TreeDataProvider<string> {
	constructor(private readonly label: string) {}

	getTreeItem(element: string): vscode.TreeItem {
		return new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.None);
	}

	getChildren(element?: string): string[] {
		if (element) {
			return [];
		}
		return [`${this.label} panel (placeholder)`];
	}
}
