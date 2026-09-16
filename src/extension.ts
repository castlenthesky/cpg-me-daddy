import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('cpg-me-daddy.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from cpg-me-daddy!');
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
