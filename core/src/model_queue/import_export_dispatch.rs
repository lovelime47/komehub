use super::*;

impl ModelQueue {
    pub(super) fn dispatch_import_export_command(&mut self, cmd: ModelCommand) -> bool {
        match cmd {
            ModelCommand::ImportEffect { zip_path, reply } => {
                self.handle_import_export_command(ImportExportCommand::ImportEffect {
                    zip_path,
                    reply,
                });
            }
            ModelCommand::ImportScene { zip_path, reply } => {
                self.handle_import_export_command(ImportExportCommand::ImportScene {
                    zip_path,
                    reply,
                });
            }
            ModelCommand::ImportPerformance {
                scene_id,
                zip_path,
                reply,
            } => {
                self.handle_import_export_command(ImportExportCommand::ImportPerformance {
                    scene_id,
                    zip_path,
                    reply,
                });
            }
            ModelCommand::ExportScene {
                scene_id,
                dest_path,
                reply,
            } => {
                self.handle_import_export_command(ImportExportCommand::ExportScene {
                    scene_id,
                    dest_path,
                    reply,
                });
            }
            ModelCommand::ExportPerformance {
                scene_id,
                performance_id,
                dest_path,
                reply,
            } => {
                self.handle_import_export_command(ImportExportCommand::ExportPerformance {
                    scene_id,
                    performance_id,
                    dest_path,
                    reply,
                });
            }
            ModelCommand::ExportEffect {
                effect_id,
                dest_path,
                reply,
            } => {
                self.handle_import_export_command(ImportExportCommand::ExportEffect {
                    effect_id,
                    dest_path,
                    reply,
                });
            }
            ModelCommand::ExportTemplate {
                template_name,
                export_name,
                scene_id,
                template_settings,
                dest_path,
                reply,
            } => {
                self.handle_import_export_command(ImportExportCommand::ExportTemplate {
                    template_name,
                    export_name,
                    scene_id,
                    template_settings,
                    dest_path,
                    reply,
                });
            }
            _ => unreachable!(
                "non-import/export ModelCommand routed to dispatch_import_export_command"
            ),
        }
        true
    }
}
