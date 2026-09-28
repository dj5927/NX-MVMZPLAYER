import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.56.0').catch(reportFatal);

